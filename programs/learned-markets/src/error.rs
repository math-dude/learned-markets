use anchor_lang::prelude::*;

#[error_code]
pub enum GateError {
    // Authorization and configuration
    #[msg("Signer is not the program upgrade authority")]
    NotDeploymentAuthority,
    #[msg("Signer is not the configured admin")]
    NotAdmin,
    #[msg("Signer is not the configured settlement authority")]
    NotSettlementAuthority,
    #[msg("Configuration value is invalid")]
    InvalidConfig,
    #[msg("Admission is suspended")]
    AdmissionSuspended,

    // Registry state
    #[msg("Participant is not active")]
    ParticipantNotActive,
    #[msg("Participant must be suspended before its binding is replaced")]
    ParticipantNotSuspended,
    #[msg("Participant has been revoked")]
    ParticipantRevoked,
    #[msg("Wallet is not the participant's current wallet")]
    WalletNotCurrent,
    #[msg("Wallet binding does not match the participant")]
    WalletBindingMismatch,
    #[msg("Wallet binding is retired")]
    WalletBindingInactive,
    #[msg("Wallet is bound to a different participant")]
    WalletBoundToOtherParticipant,
    #[msg("Account is not the canonical registry address")]
    NonCanonicalRegistryAccount,
    #[msg("Attestation is not the participant's current attestation")]
    AttestationNotCurrent,

    // SAS accounts
    #[msg("SAS account has the wrong owner")]
    SasWrongOwner,
    #[msg("SAS account has the wrong discriminator or cannot be decoded")]
    SasMalformedAccount,
    #[msg("Credential is not the trusted credential")]
    UntrustedCredential,
    #[msg("Credential authority does not match")]
    UntrustedCredentialAuthority,
    #[msg("Schema is not the trusted schema")]
    UntrustedSchema,
    #[msg("Schema version does not match")]
    SchemaVersionMismatch,
    #[msg("Schema layout does not match")]
    SchemaLayoutMismatch,
    #[msg("Attestation signer is not an authorized credential signer")]
    UnauthorizedAttestationSigner,
    #[msg("Attestation is not at the expected SAS address")]
    NonCanonicalAttestation,

    // Attestation payload
    #[msg("Attestation data is malformed")]
    MalformedAttestationData,
    #[msg("Attestation app scope does not match")]
    WrongAppScope,
    #[msg("Verification method is not allowed")]
    UnsupportedVerificationMethod,
    #[msg("Attestation participant does not match")]
    ParticipantMismatch,
    #[msg("Attestation wallet does not match")]
    WalletMismatch,
    #[msg("Attestation binding version does not match")]
    BindingVersionMismatch,
    #[msg("Attestation has no expiry")]
    NonExpiringAttestation,
    #[msg("Attestation has expired")]
    AttestationExpired,
    #[msg("Attestation validity exceeds the allowed lifetime")]
    AttestationLifetimeTooLong,
    #[msg("Attestation issuance time is in the future")]
    AttestationIssuedInFuture,

    // Badge (tokenized attestation)
    #[msg("Badge mint is not the canonical attestation mint")]
    NonCanonicalBadgeMint,
    #[msg("Badge account is not owned by Token-2022")]
    BadgeWrongTokenProgram,
    #[msg("Badge mint is malformed")]
    MalformedBadgeMint,
    #[msg("Badge mint is not non-transferable")]
    BadgeTransferable,
    #[msg("Badge mint is not a member of the schema group")]
    BadgeNotInSchemaGroup,
    #[msg("Badge mint authority is not SAS")]
    BadgeWrongMintAuthority,
    #[msg("Badge mint must have zero decimals and supply one")]
    BadgeWrongSupply,
    #[msg("Badge token account is malformed")]
    MalformedBadgeTokenAccount,
    #[msg("Badge token account does not belong to the bound wallet")]
    BadgeTokenAccountMismatch,
    #[msg("Bound wallet does not hold the badge")]
    BadgeNotHeld,

    // Intents
    #[msg("Intent nonce is not the participant's next nonce")]
    WrongIntentNonce,
    #[msg("Intent deadline is invalid")]
    InvalidIntentDeadline,
    #[msg("Intent has expired")]
    IntentExpired,
    #[msg("Intent is not open")]
    IntentNotOpen,
    #[msg("Intent does not belong to the participant")]
    IntentOwnerMismatch,
    #[msg("Intent was signed under a previous binding version")]
    StaleIntentBinding,
    #[msg("Intent target does not match")]
    IntentTargetMismatch,
    #[msg("Intent kind is not valid here")]
    WrongIntentKind,
    #[msg("Intent payload does not match its hash")]
    PayloadHashMismatch,
    #[msg("Intent payload is malformed")]
    MalformedPayload,
    #[msg("Arithmetic overflow")]
    Overflow,

    // Settlement
    #[msg("Settlement request is malformed")]
    MalformedSettlementRequest,
    #[msg("Settlement accounts are missing or substituted")]
    SettlementAccountsMismatch,
    #[msg("Duplicate intent in settlement request")]
    DuplicateSettlementIntent,
    #[msg("Settlement is not implemented")]
    SettlementNotImplemented,

    // Validation foundation
    #[msg("Account address does not match the expected reference")]
    ReferenceAddressMismatch,
    #[msg("Data account is owned by the wrong program")]
    DataAccountOwnerMismatch,
    #[msg("Executable account cannot be used as a data account")]
    ExecutableDataAccount,
    #[msg("Account data or balance could not be borrowed")]
    AccountBorrowFailed,
    #[msg("Account discriminator or data layout does not match the expected type")]
    InvalidReferenceData,
    #[msg("Token program is unsupported")]
    UnsupportedTokenProgram,
    #[msg("Token mint is uninitialized or malformed")]
    InvalidTokenMint,
    #[msg("Token account is uninitialized or malformed")]
    InvalidTokenAccount,
    #[msg("Token-2022 extension layout is malformed or unsupported")]
    InvalidTokenExtensions,
    #[msg("Token mint does not match the expected mint")]
    TokenMintMismatch,
    #[msg("Token account authority does not match the expected authority")]
    TokenAuthorityMismatch,
    #[msg("Balance is insufficient")]
    InsufficientBalance,
    #[msg("Protected amount exceeds the observed balance")]
    ProtectedAmountExceedsBalance,
    #[msg("Observed backing is less than the supplied liabilities")]
    BackingDeficit,
    #[msg("Board not initialized")]
    BoardNotInitialized,
    #[msg("Line closed")]
    LineClosed,
    #[msg("Quote mint not allowed")]
    QuoteMintNotAllowed,
    #[msg("Bounds out of range")]
    BoundsOutOfRange,
    #[msg("Limits out of range")]
    LimitsOutOfRange,
    #[msg("Market closed")]
    MarketClosed,
    #[msg("Market settling")]
    MarketSettling,
    #[msg("Wrong batch id")]
    WrongBatchId,
    #[msg("Previous batch unsettled")]
    PreviousBatchUnsettled,
    #[msg("Batch not committed")]
    BatchNotCommitted,
    #[msg("Batch not settling")]
    BatchNotSettling,
    #[msg("Batch window open")]
    BatchWindowOpen,
    #[msg("Intent outside batch window")]
    IntentOutsideBatchWindow,
    #[msg("Quote hash mismatch")]
    QuoteHashMismatch,
    #[msg("Malformed reveal")]
    MalformedReveal,
    #[msg("Terms out of bounds")]
    TermsOutOfBounds,
    #[msg("Price move too large")]
    PriceMoveTooLarge,
    #[msg("Maker curve exceeded")]
    MakerCurveExceeded,
    #[msg("Maker inventory exceeded")]
    MakerInventoryExceeded,
    #[msg("Maker budget exceeded")]
    MakerBudgetExceeded,
    #[msg("Maker limit exceeded")]
    MakerLimitExceeded,
    #[msg("Fill exceeds curve")]
    FillExceedsCurve,
    #[msg("Per person batch max exceeded")]
    PerPersonBatchMaxExceeded,
    #[msg("Hold cap exceeded")]
    HoldCapExceeded,
    #[msg("Fee exceeds proceeds")]
    FeeExceedsProceeds,
    #[msg("Duplicate participant in chunk")]
    DuplicateParticipantInChunk,
    #[msg("Declared totals exceeded")]
    DeclaredTotalsExceeded,
    #[msg("Declared totals mismatch")]
    DeclaredTotalsMismatch,
    #[msg("Cannot abort started batch")]
    CannotAbortStartedBatch,
    #[msg("Vault invariant violated")]
    VaultInvariantViolated,
    #[msg("Invalid stage transition")]
    InvalidStageTransition,
    #[msg("Not quoter")]
    NotQuoter,
    #[msg("Not board authority")]
    NotBoardAuthority,
    #[msg("Not auction authority")]
    NotAuctionAuthority,
    #[msg("Already swept")]
    AlreadySwept,
    #[msg("Nothing to claim")]
    NothingToClaim,

    #[msg("Synthetic ledger credits are disabled for this build or network")]
    LedgerCreditDisabled,
    #[msg("Ledger fill has zero quantity or exceeds the submitted step curve")]
    InvalidLedgerFill,
    #[msg("Seller fee rate must be between 10000 and 250000 ppm")]
    LedgerFeeRateOutOfRange,
    #[msg("The supplied user and quoter legs do not conserve tokens")]
    LedgerTokenMismatch,
    #[msg("Survivor accounts must be distinct live ledger markets paired with their deployer's balance")]
    InvalidSurvivor,
}
