"""Typed program access through Codama-generated bindings."""

from dataclasses import dataclass

from anchorpy.error import AccountInvalidDiscriminator
from construct import ConstructError
from solana.rpc.async_api import AsyncClient
from solders.instruction import AccountMeta, Instruction
from solders.pubkey import Pubkey

from .contracts import ClearRequest
from .generated.accounts.ledgerMarket import LedgerMarket
from .generated.instructions.settleLedgerBatch import SettleLedgerBatch
from .generated.program_id import LEARNED_MARKETS_PROGRAM_ADDRESS as PROGRAM_ID
from .generated.types.ledgerFill import LedgerFill


def ledger_market_address(market_id: Pubkey):
    return Pubkey.find_program_address([b"ledger-market", bytes(market_id)], PROGRAM_ID)


def ledger_balance_address(participant: Pubkey):
    return Pubkey.find_program_address(
        [b"ledger-balance", bytes(participant)], PROGRAM_ID
    )[0]


def ledger_position_address(market: Pubkey, participant: Pubkey):
    return Pubkey.find_program_address(
        [b"ledger-position", bytes(market), bytes(participant)], PROGRAM_ID
    )[0]


async def read_market(rpc: AsyncClient, address: Pubkey):
    response = await rpc.get_account_info(address, commitment="confirmed")
    account = response.value
    if account is None:
        raise LookupError("ledger market does not exist")
    if account.owner != PROGRAM_ID or account.executable:
        raise ValueError("invalid market account owner or executable flag")
    try:
        market = LedgerMarket.decode(account.data)
    except (AccountInvalidDiscriminator, ConstructError) as error:
        raise ValueError("malformed ledger market account") from error
    expected, bump = ledger_market_address(market.marketId)
    if expected != address or bump != market.bump or market.version != 1:
        raise ValueError("invalid ledger market PDA or version")
    return {
        "context_slot": str(response.context.slot),
        "address": str(address),
        "market_id": str(market.marketId),
        "deployer": str(market.deployer),
        "reserve_cash": str(market.reserveCash),
        "reserve_tokens": str(market.reserveTokens),
        "last_batch_id": str(market.lastBatchId)
        if market.lastBatchId is not None
        else None,
        "last_price": str(market.lastPrice),
        "live": market.live,
    }


@dataclass(frozen=True)
class TraderAccounts:
    participant: Pubkey
    wallet_binding: Pubkey
    attestation: Pubkey
    badge_mint: Pubkey
    badge_token: Pubkey


def settlement_instruction(
    request: ClearRequest,
    result: dict,
    market: Pubkey,
    settlement_authority: Pubkey,
    config: Pubkey,
    credential: Pubkey,
    schema: Pubkey,
    schema_mint: Pubkey,
    traders: dict[str, TraderAccounts],
) -> Instruction:
    """Build an unsigned instruction. The program validates eligibility and every fill.

    The caller supplies its frozen clearing request and the result returned by
    /clear. Transaction signing and confirmed-state reconciliation belong to the
    settlement service.
    """
    import struct

    if int(result["batch_id"]) != request.market.batch_id:
        raise ValueError("clearing result belongs to a different batch")
    orders = {order.intent: order for order in request.user_curves}
    fills, remaining = [], []
    seen = set()
    for fill in result["fills"]:
        order = orders[fill["intent"]]
        if (
            order.participant != fill["participant"]
            or order.side != fill["side"]
            or order.participant in seen
            or int(fill["quantity"]) <= 0
        ):
            raise ValueError("duplicate or mismatched fill participant")
        seen.add(order.participant)
        trader = traders[order.participant]
        if str(trader.participant) != order.participant:
            raise ValueError("participant address mismatch")
        intent = Pubkey.from_string(order.intent)
        points = b"".join(
            struct.pack("<QQ", point.price, point.quantity) for point in order.curve
        )
        contents = bytes([1, int(order.side == "sell"), len(order.curve)]) + points
        fills.append(
            LedgerFill(
                intent, contents, int(fill["quantity"]), int(fill["fee_rate_ppm"])
            )
        )
        accounts = [
            (intent, True),
            (trader.participant, False),
            (trader.wallet_binding, False),
            (trader.attestation, False),
            (trader.badge_mint, False),
            (trader.badge_token, False),
            (ledger_balance_address(trader.participant), True),
            (ledger_position_address(market, trader.participant), True),
        ]
        remaining.extend(
            AccountMeta(key, False, writable) for key, writable in accounts
        )

    expected_config = Pubkey.find_program_address([b"config"], PROGRAM_ID)[0]
    if config != expected_config:
        raise ValueError("noncanonical config")
    return SettleLedgerBatch(
        {
            "market": market,
            "batchId": int(result["batch_id"]),
            "clearingPrice": int(result["clearing_price"]),
            "quoterBuy": int(result["quoter_buy"]),
            "quoterSell": int(result["quoter_sell"]),
            "intents": fills,
        },
        {
            "settlementAuthority": settlement_authority,
            "config": config,
            "market": market,
            "platform": Pubkey.find_program_address([b"ledger-platform"], PROGRAM_ID)[
                0
            ],
            "credential": credential,
            "schema": schema,
            "schemaMint": schema_mint,
        },
        remaining_accounts=remaining,
    )
