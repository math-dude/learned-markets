//! Canonical, versioned intent payloads.
//!
//! payload_hash = sha256(
//!     u32le(len(DOMAIN)) || DOMAIN
//!  || u8 payload_version (= 1)
//!  || u32le(len(app_scope)) || app_scope
//!  || u32le(len(network))   || network
//!  || u8 kind
//!  || target (32 bytes)
//!  || u32le(len(contents))  || contents )
//!
//! `contents` is the kind-specific canonical encoding below. TypeScript and
//! Rust share the test vectors in `fixtures/intent-payload-vectors.json`.

use anchor_lang::prelude::*;

use crate::{constants::*, error::GateError, state::IntentKind};

pub fn payload_hash(
    app_scope: &str,
    network: &str,
    kind: IntentKind,
    target: &Pubkey,
    contents: &[u8],
) -> [u8; 32] {
    let domain_len = (INTENT_PAYLOAD_DOMAIN.len() as u32).to_le_bytes();
    let scope_len = (app_scope.len() as u32).to_le_bytes();
    let network_len = (network.len() as u32).to_le_bytes();
    let contents_len = (contents.len() as u32).to_le_bytes();
    solana_sha256_hasher::hashv(&[
        &domain_len,
        INTENT_PAYLOAD_DOMAIN,
        &[INTENT_PAYLOAD_VERSION],
        &scope_len,
        app_scope.as_bytes(),
        &network_len,
        network.as_bytes(),
        &[kind.code()],
        target.as_ref(),
        &contents_len,
        contents,
    ])
    .to_bytes()
}

pub const TRADE_CONTENTS_VERSION: u8 = 1;
pub const NOMINATION_CONTENTS_VERSION: u8 = 1;
pub const MAX_CURVE_POINTS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

/// One point of a curve order: at `price` (quote atoms per whole base token,
/// i.e. per 10^decimals base atoms) the participant is willing to trade up to
/// `quantity` base atoms in total.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurvePoint {
    pub price: u64,
    pub quantity: u64,
}

/// Curve order for a sealed uniform-price batch.
///
/// contents = u8 version(=1) || u8 side (0 buy, 1 sell) || u8 n (1..=16)
///         || n × (u64le price || u64le quantity)
///
/// Canonical form: prices strictly increasing; quantities are monotone in the
/// economically sensible direction (buy: non-increasing as price rises,
/// sell: non-decreasing) and at least one quantity is non-zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeContents {
    pub side: Side,
    pub points: Vec<CurvePoint>,
}

impl TradeContents {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(3 + self.points.len() * 16);
        out.push(TRADE_CONTENTS_VERSION);
        out.push(match self.side {
            Side::Buy => 0,
            Side::Sell => 1,
        });
        out.push(self.points.len() as u8);
        for p in &self.points {
            out.extend_from_slice(&p.price.to_le_bytes());
            out.extend_from_slice(&p.quantity.to_le_bytes());
        }
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        require!(data.len() >= 3, GateError::MalformedPayload);
        require!(data[0] == TRADE_CONTENTS_VERSION, GateError::MalformedPayload);
        let side = match data[1] {
            0 => Side::Buy,
            1 => Side::Sell,
            _ => return err!(GateError::MalformedPayload),
        };
        let n = data[2] as usize;
        require!(
            (1..=MAX_CURVE_POINTS).contains(&n),
            GateError::MalformedPayload
        );
        require!(data.len() == 3 + n * 16, GateError::MalformedPayload);
        let points: Vec<CurvePoint> = (0..n)
            .map(|i| {
                let o = 3 + i * 16;
                CurvePoint {
                    price: u64::from_le_bytes(data[o..o + 8].try_into().unwrap()),
                    quantity: u64::from_le_bytes(data[o + 8..o + 16].try_into().unwrap()),
                }
            })
            .collect();
        let contents = Self { side, points };
        contents.validate()?;
        Ok(contents)
    }

    pub fn validate(&self) -> Result<()> {
        require!(
            (1..=MAX_CURVE_POINTS).contains(&self.points.len()),
            GateError::MalformedPayload
        );
        require!(
            self.points.iter().all(|p| p.price > 0),
            GateError::MalformedPayload
        );
        require!(
            self.points.iter().any(|p| p.quantity > 0),
            GateError::MalformedPayload
        );
        for w in self.points.windows(2) {
            require!(w[0].price < w[1].price, GateError::MalformedPayload);
            let ok = match self.side {
                Side::Buy => w[0].quantity >= w[1].quantity,
                Side::Sell => w[0].quantity <= w[1].quantity,
            };
            require!(ok, GateError::MalformedPayload);
        }
        Ok(())
    }
}

/// Nomination of a launch candidate.
/// contents = u8 version(=1) || candidate (32 bytes)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NominationContents {
    pub candidate: Pubkey,
}

impl NominationContents {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(33);
        out.push(NOMINATION_CONTENTS_VERSION);
        out.extend_from_slice(self.candidate.as_ref());
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        require!(data.len() == 33, GateError::MalformedPayload);
        require!(
            data[0] == NOMINATION_CONTENTS_VERSION,
            GateError::MalformedPayload
        );
        let candidate = Pubkey::new_from_array(data[1..33].try_into().unwrap());
        require!(candidate != Pubkey::default(), GateError::MalformedPayload);
        Ok(Self { candidate })
    }
}

pub fn validate_contents(kind: IntentKind, contents: &[u8]) -> Result<()> {
    match kind {
        IntentKind::Trade => TradeContents::decode(contents).map(|_| ()),
        IntentKind::Nomination => NominationContents::decode(contents).map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buy() -> TradeContents {
        TradeContents {
            side: Side::Buy,
            points: vec![
                CurvePoint { price: 100, quantity: 5_000 },
                CurvePoint { price: 120, quantity: 2_000 },
                CurvePoint { price: 150, quantity: 0 },
            ],
        }
    }

    #[test]
    fn trade_round_trip_and_rules() {
        let t = buy();
        assert_eq!(TradeContents::decode(&t.encode()).unwrap(), t);

        let mut bad = buy();
        bad.points.swap(0, 1);
        assert!(TradeContents::decode(&bad.encode()).is_err());

        let mut bad = buy();
        bad.side = Side::Sell; // quantities decrease → invalid for a sell curve
        assert!(TradeContents::decode(&bad.encode()).is_err());

        let mut bytes = buy().encode();
        bytes.push(0);
        assert!(TradeContents::decode(&bytes).is_err());
    }

    #[test]
    fn hash_depends_on_every_field() {
        let target = Pubkey::new_from_array([3u8; 32]);
        let c = buy().encode();
        let h = payload_hash(APP_SCOPE, "devnet", IntentKind::Trade, &target, &c);
        assert_ne!(h, payload_hash(APP_SCOPE, "mainnet", IntentKind::Trade, &target, &c));
        assert_ne!(h, payload_hash("other", "devnet", IntentKind::Trade, &target, &c));
        assert_ne!(h, payload_hash(APP_SCOPE, "devnet", IntentKind::Nomination, &target, &c));
        assert_ne!(
            h,
            payload_hash(APP_SCOPE, "devnet", IntentKind::Trade, &Pubkey::default(), &c)
        );
        let mut c2 = c.clone();
        c2[4] ^= 1;
        assert_ne!(h, payload_hash(APP_SCOPE, "devnet", IntentKind::Trade, &target, &c2));
    }
}
