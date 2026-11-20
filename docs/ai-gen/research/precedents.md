# Precedents

Real products and academic work behind the design, gathered 2026-11-19.

## Coin survival and elimination games

- **Fomo3D / Reddit's The Button:** each purchase extends a countdown; zero ends the round. Proven engagement; first Fomo3D round was won by a block-stuffing attack at the deadline (batch auctions + identity block this). [Anatomy of a block stuffing attack](https://solmaz.io/2018/10/18/anatomy-block-stuffing/), [The Tale of Fomo3D](https://yacn.substack.com/p/front-running-ethereum)
- **Meme Royale (Solana):** coins battle; losing coin's holders convert into the winner. [Solana Compass](https://wild.solanacompass.com/projects/meme-royale)
- **ArenaDAO (BNB Chain):** loser's vault swapped into the winner's tokens. [Mitrade](https://www.mitrade.com/insights/news/live-news/article-3-1929373-20260723)
- **Awakeness:** losing token's liquidity transferred to the winner each round. [Docs](https://awakeness.gitbook.io/awakeness/awakeness-overview/awakeness-tournament/winnings)
- **BNB Chain meme liquidity competition:** scored contest ended in a public dispute over the score. Keep rules simple and on-chain. [Cointelegraph](https://cointelegraph.com/news/dog-eat-dog-drama-erupts-in-bnb-chain-s-broccoli-token-showdown)
- **Game theory:** war of attrition (Maynard Smith 1974), replicator dynamics, rank-order tournaments (Lazear–Rosen 1981), Tullock contests (1980), Keynesian beauty contest, quadratic funding (Buterin, Hitzig, Weyl) for square-root breadth.

## Listing and delisting

- **Futures exchanges:** most new contracts fail (Silber 1981: under a third reached 10,000 contracts/year after three years); CME routinely delists contracts with no open interest; duplicates tip to one venue (Cboe stopped bitcoin futures as volume went to CME). [AgEcon summary](https://ageconsearch.umn.edu/record/19018/files/cp04ra01.pdf), [CFTC lifecycle study](https://www.cftc.gov/idc/groups/public/@economicanalysis/documents/file/oce_lifecycleofexchange.pdf), [CME delisting notice](https://www.cmegroup.com/content/dam/cmegroup/notices/ser/2025/03/ser-9515.pdf)
- **Duffie & Jackson (1989), Optimal Innovation of Futures Contracts:** volume-maximizing exchanges choosing what to list; multi-period incentive to induce turnover breaks optimality (why we count distinct people, not raw volume). [RFS](https://academicnewsletter.sufe.edu.cn/info/355938)
- **Cuny (1993):** exchange designs both the contract and trader participation (cold start). [RFS](https://scilit.com/publications/cf8f43819fa5efbb6e6f09cf997eeb17)
- **Janardanan, Qiao, Rouwenhorst (2024):** contracts with extreme returns fail more often. [SSRN](https://www.scribd.com/document/714166337/SSRN-id4730746)
- **pump.fun survival:** 68.7% of 18.67M tokens last traded on launch day; 4.55% past 90 days (CoinGecko, Jan 2024–Jun 2026). [Crypto Briefing](https://cryptobriefing.com/pump-fun-token-survival-rate-study/)

## RL over limited slots (stage manager)

- **SlateQ (Google/YouTube, 2019):** RL over slates for long-term engagement; slate value decomposes into item values; validated live on YouTube. [arXiv](https://arxiv.org/pdf/1905.12767)
- **MNL-bandit (Agrawal et al.):** limited-capacity assortment under unknown demand; low-switching variants. [arXiv](https://web3.arxiv.org/abs/1706.03880), [low switching](https://ar5iv.labs.arxiv.org/html/2007.04876)
- **Cross DQN (Meituan):** RL decides number and position of ad slots in a feed; deployed to 300M+ users. [arXiv](https://arxiv.org/pdf/2109.04353)
- **Airline seat RL (Gosavi et al.):** seat inventory control, protected seats; beats EMSR-b. [Springer](https://link.springer.com/article/10.1023/A:1015583703449), [Deep RL version](https://arxiv.org/pdf/1902.06824.pdf)

## Market makers and liquidity

- **Designated market makers in call auctions:** improve market quality by reducing temporal order-flow imbalances; chosen by younger, smaller firms (Venkataraman & Waisburd 2007). [JFQA](https://econpapers.repec.org/RePEc:cup:jfinqa:v:42:y:2007:i:03:p:735-758_00); most active in illiquid stocks and volatile times. [Frankfurt](https://publikationen.ub.uni-frankfurt.de/frontdoor/index/index/year/2021/docId/61552)
- **TSX bundling:** cross-subsidizing small-stock market making from large stocks lowers costs. [TMX](https://tmx.com/en/resource/799)
- **IPO stabilization (Aggarwal 2000):** short covering and penalty bids on flippers; costs underwriters ~3.6% of fees. Basis for soft holds. [J. Finance](https://econbiz.de/Record/stabilization-activities-by-underwriters-after-initial-public-offerings-aggarwal-reena/10005691491)
- **Hanson's LMSR:** automated market makers exist to solve thin markets. [arXiv](https://arxiv.org/pdf/2009.01676)
- **Melee Markets:** no single maker; early traders supply liquidity; exits via discounted cashout vault. [Solana Compass](https://solanacompass.com/projects/melee-markets)

## Cautionary tales

- **Hyperliquid JELLY (Mar 2025):** shared HLP vault couldn't absorb a manipulated memecoin position; team delisted and settled by fiat; centralization backlash. Cap per-coin exposure of any shared pool. [Arkham](https://info.arkm.com/research/jellyjelly-exploit-on-hyperliquid)
- **Bancor IL protection (Jun 2022):** guarantee suspended in a downturn; lawsuit followed. Only promise what each coin funds itself. [The Block](https://www.theblock.co/news/defi/2022-06-20-bancor-dex-pauses-impermanent-loss-protection-amid-market-instability), [Decrypt](https://decrypt.co/140434/defi-project-bancor-hit-lawsuit-over-impermanent-loss-protection-promises?amp=1)

## Social deployment

- **Clanker:** tag a bot in a Farcaster/X post to deploy a token. [Docs](https://clanker.gitbook.io/documentation/general/token-deployments/deploying-a-token)
- **Believe:** reply to the Launchcoin X account with a ticker; crowd decides via buys. [CoinGecko](https://www.coingecko.com/learn/what-is-believe-token-launchpad), [Bankless](https://www.bankless.com/read/believe-solana-token-launcher)
- **TikTok Creative Center:** public trending-hashtag board, no official trends API (Research API is academic-only). [Apify listing](https://apify.com/api-empire/tiktok-trending-hashtags-analytics-scraper)

## Healthy-chart measurement

- **MemeTrans:** 41,470 pump.fun launches, 122 features; concentration and bundle-adjusted ownership reveal insider coordination. [arXiv](https://arxiv.org/abs/2602.13480)
- **Market quality measures:** variance ratio (Lo & MacKinlay 1988), Kyle's λ, Amihud illiquidity. [Polymarket-v1](https://arxiv.org/pdf/2606.04217); effective minus realized spread as price impact (Aitken & Harris 2011). [J. Trading](https://jot.iijournals.com/highwire/citation/1013/refworks-tagged)
- **RL market-making rewards:** profit, inventory and market quality; dampened PnL (Spooner et al. 2018). [arXiv](https://arxiv.org/pdf/1804.04216), [review](https://arxiv.org/pdf/2411.12746)
