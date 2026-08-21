# Sleeper Dynasty League Bridge

Cloudflare Worker that snapshots the Sleeper dynasty league into GitHub and builds historical, transactional, projection, and dynasty-value datasets.

## Current capabilities

- Automatic Sleeper season rollover
- Current rosters, standings, drafts, transactions, trades, and pick ownership
- Daily and manual event snapshots
- Multi-season game and playoff history
- Owner tendency profiles
- Three-feed dynasty player values from FantasyCalc, DynastyProcess, and Dynasty Dealer
- Three-source weekly and full-season player projection consensus
- Optimized weekly lineup and matchup projections
- Projection-enhanced franchise power rankings
- Historical league records and franchise leaderboards
- All-play records, luck ratings, and schedule strength
- Head-to-head rivalry rankings and series histories
- Deterministic owner archetypes and weekly/historical awards

## Main generated files

- `current.json` — current league and roster snapshot
- `player-values.json` — player rankings, source values, consensus values, confidence, and team roster values
- `projection-summary.json` — season player rankings, weekly matrices, team forecasts, and projected records
- `projections/<season>/season.json` — full-season player and optimal-lineup projections
- `projections/<season>/weeks/week-XX.json` — player, lineup, and matchup projections for one week
- `power-rankings.json` — 50% roster value, 30% competitive strength, and 20% draft capital
- `league-intelligence.json` — records, franchise history, all-play/luck, rivalries, owner archetypes, season summaries, and awards
- `game-history.json` and `playoff-history.json` — unified historical results
- `owner-tendencies.json` — owner activity and trade behavior

## Projection and value sources

Weekly and season projections combine three independent providers:

- Sleeper's publicly reachable projection feed, which currently identifies RotoWire as the provider
- ESPN's public fantasy player pool
- StatHead's open weekly projection model

Each available source receives equal weight for a player. Missing sources are ignored rather than treated as zero. Sleeper and ESPN counting stats are rescored for the league; StatHead PPR points are adjusted using the player's Sleeper league-to-PPR factor when available. Every player retains source count, source spread, and confidence. The GitHub output stores the league-specific consensus and coverage metadata, not ESPN's raw bulk projection table.

Equal weights are the honest starting point because no complete, timestamped, apples-to-apples public archive currently supports a defensible historical winner among these exact feeds. Source weighting can be calibrated from live league-season errors after enough completed weeks exist.

Yahoo is not included because its official Fantasy Sports API does not provide the player-level weekly projection feed shown inside Yahoo's consumer app. The Worker does not scrape hidden endpoints or require Yahoo browser cookies.

Dynasty market value combines:

- FantasyCalc values derived from completed fantasy trades
- DynastyProcess values derived from FantasyPros expert consensus rankings
- Dynasty Dealer values derived from real Sleeper dynasty trades

Each source is normalized first. Because FantasyCalc and Dynasty Dealer are both trade-market models, they are averaged into one market lens; the market lens and the DynastyProcess expert lens then receive equal weight. This prevents the same broad market signal from being counted twice. Missing data is not treated as zero, and source disagreement is retained as a confidence signal.

## Routes

Public read-only routes:

- `/`
- `/health`
- `/chain`

Protected GitHub-writing routes include:

- `/sync`
- `/snapshot?label=OPTIONAL_LABEL`
- `/rebuild-player-intelligence`
- `/rebuild-league-intelligence`
- `/rebuild-player-values`
- `/rebuild-projections?season=1`
- `/rebuild-projections?week=1`
- `/rebuild-projections?batch=1`
- `/rebuild-projections?finalize=1`
- `/rebuild-power-rankings`
- `/rebuild-games`, `/rebuild-ledger`, `/rebuild-picks`, and `/rebuild-tendencies`

Protected routes accept Basic or Bearer authentication using the `DYNASTY_WRITE_PASSWORD` Worker secret. The GitHub token is stored separately as `GITHUB_TOKEN`.

## Automatic maintenance

Cloudflare invokes the Worker every three hours. Core league data, history, tendencies, player values, projections, power rankings, and league intelligence refresh on staggered schedules. Weekly projection files rotate in three-week batches, covering all 18 weeks every three days while keeping each Worker execution within bounded subrequest limits. League intelligence refreshes daily and immediately after the weekly game-history finalization.

## Historical intelligence methodology

Historical analytics use only matchups explicitly marked complete; future placeholder games are excluded. All-play compares every team with every other score from the same completed regular-season week. Expected wins convert that weekly all-play result to a zero-to-one value, and luck equals actual win-equivalents minus expected wins. Owner identity follows the stable Sleeper user across team-name changes. Rivalry scores combine meeting volume, series balance, average margin, and postseason meetings. Owner archetypes are deterministic descriptions based on league-relative activity, pick flow, roster age, and current competitive strength.
