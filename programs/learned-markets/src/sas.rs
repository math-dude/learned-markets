//! Decoding and validation of Solana Attestation Service accounts and the
//! Token-2022 badge minted by `CreateTokenizedAttestation`.
//!
//! Everything here is pure (no CPI, no state writes) so it can be unit tested
//! on the host and reused by every protected instruction.

use anchor_lang::prelude::*;
use solana_attestation::accounts::{Attestation, Credential, Schema};

use crate::{constants::*, error::GateError};

/// Decoded `learned-markets-participant` v1 attestation payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParticipantData {
    pub app_scope: String,
    pub participant_id: [u8; 32],
    pub wallet: Pubkey,
    pub verification_method: u8,
    pub binding_version: u32,
    pub issued_at: i64,
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .filter(|end| *end <= self.data.len())
            .ok_or(GateError::MalformedAttestationData)?;
        let out = &self.data[self.offset..end];
        self.offset = end;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn len_prefixed(&mut self) -> Result<&'a [u8]> {
        let len = self.u32()? as usize;
        self.take(len)
    }
}

impl ParticipantData {
    /// Decodes the payload using schema layout `[12, 13, 13, 0, 2, 8]` and
    /// enforces exact lengths (SAS only validates the type structure).
    pub fn decode(data: &[u8]) -> Result<Self> {
        let mut r = Reader { data, offset: 0 };
        let app_scope = core::str::from_utf8(r.len_prefixed()?)
            .map_err(|_| GateError::MalformedAttestationData)?
            .to_string();
        let participant_id: [u8; 32] = r
            .len_prefixed()?
            .try_into()
            .map_err(|_| GateError::MalformedAttestationData)?;
        let wallet: [u8; 32] = r
            .len_prefixed()?
            .try_into()
            .map_err(|_| GateError::MalformedAttestationData)?;
        let verification_method = r.take(1)?[0];
        let binding_version = r.u32()?;
        let issued_at = i64::from_le_bytes(r.take(8)?.try_into().unwrap());
        require!(r.offset == data.len(), GateError::MalformedAttestationData);
        Ok(Self {
            app_scope,
            participant_id,
            wallet: Pubkey::new_from_array(wallet),
            verification_method,
            binding_version,
            issued_at,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.app_scope.len() + 36 + 36 + 1 + 4 + 8);
        out.extend_from_slice(&(self.app_scope.len() as u32).to_le_bytes());
        out.extend_from_slice(self.app_scope.as_bytes());
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(&self.participant_id);
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(self.wallet.as_ref());
        out.push(self.verification_method);
        out.extend_from_slice(&self.binding_version.to_le_bytes());
        out.extend_from_slice(&self.issued_at.to_le_bytes());
        out
    }
}

/// Deterministic SAS attestation nonce for (participant, binding version).
/// Makes the attestation address predictable and prevents duplicate issuance
/// of the same binding version.
pub fn attestation_nonce(participant_id: &[u8; 32], binding_version: u32) -> Pubkey {
    let hash = solana_sha256_hasher::hashv(&[
        ATTESTATION_NONCE_DOMAIN,
        participant_id,
        &binding_version.to_le_bytes(),
    ]);
    Pubkey::new_from_array(hash.to_bytes())
}

/// Semantic checks on attestation timing, using the on-chain clock.
pub fn check_validity_window(issued_at: i64, expiry: i64, now: i64) -> Result<()> {
    require!(expiry != 0, GateError::NonExpiringAttestation);
    require!(now < expiry, GateError::AttestationExpired);
    let skew_limit = now
        .checked_add(MAX_ISSUED_AT_FUTURE_SKEW_SECS)
        .ok_or(GateError::Overflow)?;
    require!(issued_at <= skew_limit, GateError::AttestationIssuedInFuture);
    require!(issued_at < expiry, GateError::AttestationLifetimeTooLong);
    let lifetime = expiry.checked_sub(issued_at).ok_or(GateError::Overflow)?;
    require!(
        lifetime <= MAX_ATTESTATION_LIFETIME_SECS,
        GateError::AttestationLifetimeTooLong
    );
    Ok(())
}

pub fn decode_credential(info: &AccountInfo, sas_program: &Pubkey) -> Result<Credential> {
    require_keys_eq!(*info.owner, *sas_program, GateError::SasWrongOwner);
    let data = info.try_borrow_data()?;
    require!(
        data.first() == Some(&SAS_CREDENTIAL_DISCRIMINATOR),
        GateError::SasMalformedAccount
    );
    Credential::from_bytes(&data).map_err(|_| error!(GateError::SasMalformedAccount))
}

pub fn decode_schema(info: &AccountInfo, sas_program: &Pubkey) -> Result<Schema> {
    require_keys_eq!(*info.owner, *sas_program, GateError::SasWrongOwner);
    let data = info.try_borrow_data()?;
    require!(
        data.first() == Some(&SAS_SCHEMA_DISCRIMINATOR),
        GateError::SasMalformedAccount
    );
    Schema::from_bytes(&data).map_err(|_| error!(GateError::SasMalformedAccount))
}

pub fn decode_attestation(info: &AccountInfo, sas_program: &Pubkey) -> Result<Attestation> {
    require_keys_eq!(*info.owner, *sas_program, GateError::SasWrongOwner);
    let data = info.try_borrow_data()?;
    require!(
        data.first() == Some(&SAS_ATTESTATION_DISCRIMINATOR),
        GateError::SasMalformedAccount
    );
    Attestation::from_bytes(&data).map_err(|_| error!(GateError::SasMalformedAccount))
}

// ---------------------------------------------------------------------------
// Token-2022 parsing (manual TLV walk; avoids pulling the token-2022 crate).
// ---------------------------------------------------------------------------

const BASE_MINT_LEN: usize = 82;
const BASE_ACCOUNT_LEN: usize = 165;
/// Extensions start after the account-type byte that follows the
/// (padded) 165-byte base region.
const ACCOUNT_TYPE_OFFSET: usize = BASE_ACCOUNT_LEN;
const TLV_START: usize = BASE_ACCOUNT_LEN + 1;
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

const EXT_NON_TRANSFERABLE: u16 = 9;
const EXT_TOKEN_GROUP_MEMBER: u16 = 23;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BadgeMint {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub non_transferable: bool,
    /// (member mint, group) from the TokenGroupMember extension.
    pub group_member: Option<(Pubkey, Pubkey)>,
}

fn find_extension(data: &[u8], ext: u16) -> Option<&[u8]> {
    let mut offset = TLV_START;
    while offset + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let start = offset + 4;
        let end = start.checked_add(len)?;
        if end > data.len() {
            return None;
        }
        if ty == ext {
            return Some(&data[start..end]);
        }
        // Uninitialized (zero) entries terminate the TLV region.
        if ty == 0 && len == 0 {
            return None;
        }
        offset = end;
    }
    None
}

fn read_coption_pubkey(bytes: &[u8]) -> Option<Pubkey> {
    let tag = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    if tag == 1 {
        Some(Pubkey::new_from_array(bytes[4..36].try_into().unwrap()))
    } else {
        None
    }
}

pub fn parse_badge_mint(data: &[u8]) -> Result<BadgeMint> {
    require!(data.len() > TLV_START, GateError::MalformedBadgeMint);
    require!(
        data[ACCOUNT_TYPE_OFFSET] == ACCOUNT_TYPE_MINT,
        GateError::MalformedBadgeMint
    );
    // Padding between the base mint and the account-type byte must be zero.
    require!(
        data[BASE_MINT_LEN..BASE_ACCOUNT_LEN].iter().all(|b| *b == 0),
        GateError::MalformedBadgeMint
    );
    let is_initialized = data[45];
    require!(is_initialized == 1, GateError::MalformedBadgeMint);
    let group_member = find_extension(data, EXT_TOKEN_GROUP_MEMBER)
        .filter(|v| v.len() >= 72)
        .map(|v| {
            (
                Pubkey::new_from_array(v[0..32].try_into().unwrap()),
                Pubkey::new_from_array(v[32..64].try_into().unwrap()),
            )
        });
    Ok(BadgeMint {
        mint_authority: read_coption_pubkey(&data[0..36]),
        supply: u64::from_le_bytes(data[36..44].try_into().unwrap()),
        decimals: data[44],
        non_transferable: find_extension(data, EXT_NON_TRANSFERABLE).is_some(),
        group_member,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BadgeTokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// 1 = initialized, 2 = frozen.
    pub state: u8,
}

pub fn parse_token_account(data: &[u8]) -> Result<BadgeTokenAccount> {
    require!(
        data.len() >= BASE_ACCOUNT_LEN,
        GateError::MalformedBadgeTokenAccount
    );
    if data.len() > BASE_ACCOUNT_LEN {
        require!(
            data[ACCOUNT_TYPE_OFFSET] == ACCOUNT_TYPE_ACCOUNT,
            GateError::MalformedBadgeTokenAccount
        );
    }
    Ok(BadgeTokenAccount {
        mint: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
        state: data[108],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ParticipantData {
        ParticipantData {
            app_scope: APP_SCOPE.to_string(),
            participant_id: [7u8; 32],
            wallet: Pubkey::new_from_array([9u8; 32]),
            verification_method: 0,
            binding_version: 1,
            issued_at: 1_763_500_000,
        }
    }

    #[test]
    fn participant_data_round_trip() {
        let d = sample();
        assert_eq!(ParticipantData::decode(&d.encode()).unwrap(), d);
    }

    #[test]
    fn participant_data_rejects_trailing_and_short_fields() {
        let mut bytes = sample().encode();
        bytes.push(0);
        assert!(ParticipantData::decode(&bytes).is_err());

        // participant_id of 31 bytes
        let mut d = Vec::new();
        d.extend_from_slice(&(APP_SCOPE.len() as u32).to_le_bytes());
        d.extend_from_slice(APP_SCOPE.as_bytes());
        d.extend_from_slice(&31u32.to_le_bytes());
        d.extend_from_slice(&[1u8; 31]);
        d.extend_from_slice(&32u32.to_le_bytes());
        d.extend_from_slice(&[2u8; 32]);
        d.push(0);
        d.extend_from_slice(&1u32.to_le_bytes());
        d.extend_from_slice(&0i64.to_le_bytes());
        assert!(ParticipantData::decode(&d).is_err());

        assert!(ParticipantData::decode(&[]).is_err());
    }

    #[test]
    fn validity_window_boundaries() {
        let now = 1_000_000;
        let week = MAX_ATTESTATION_LIFETIME_SECS;
        assert!(check_validity_window(now, now + week, now).is_ok());
        assert!(check_validity_window(now, now + week + 1, now).is_err());
        assert!(check_validity_window(now, 0, now).is_err());
        assert!(check_validity_window(now - 10, now, now).is_err()); // expired at boundary
        assert!(check_validity_window(now - 10, now + 1, now).is_ok());
        assert!(check_validity_window(now + 30, now + 100, now).is_ok());
        assert!(check_validity_window(now + 31, now + 100, now).is_err());
    }
}
