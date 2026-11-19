-- Vamp (copycat) detection on pump_creates.
-- A "vamp" is a create whose normalized name or symbol matches an EARLIER create.
-- Normalization: lowercase, strip everything except a-z and 0-9.

WITH c AS (
    SELECT
        mint, name, symbol, creator, timestamp, slot,
        replaceRegexpAll(lower(name),   '[^a-z0-9]', '') AS nname,
        replaceRegexpAll(lower(symbol), '[^a-z0-9]', '') AS nsym
    FROM pump_creates FINAL
    WHERE nsym != ''
),
ranked AS (
    SELECT *,
        row_number() OVER (PARTITION BY nsym ORDER BY slot, mint) AS copy_rank,
        first_value(mint) OVER (PARTITION BY nsym ORDER BY slot, mint) AS original_mint,
        first_value(timestamp) OVER (PARTITION BY nsym ORDER BY slot, mint) AS original_ts
    FROM c
)
SELECT
    nsym                                   AS normalized_symbol,
    any(original_mint)                     AS original_mint,
    count()                                AS creates,
    count() - 1                            AS vamps,
    uniqExact(creator)                     AS distinct_creators,
    quantile(0.5)(timestamp - original_ts) AS median_seconds_after_original
FROM ranked
GROUP BY nsym
HAVING vamps > 0
ORDER BY vamps DESC
LIMIT 200;
