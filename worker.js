import { buildLeagueIntelligencePayload } from "./league-intelligence.js";

const LEAGUE_ANCHOR_ID = "1327788752298336256";
const LEAGUE_ANCHOR_USER_ID = "1129875387229560832";
const MAX_LEAGUE_CHAIN_LENGTH = 50;
const SLEEPER = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS = "https://api.sleeper.com/projections/nfl";
const FANTASY_CALC = "https://api.fantasycalc.com/values/current";
const DYNASTY_PROCESS_VALUES = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv";
const DYNASTY_DEALER_VALUES = "https://www.dynastydealer.com/api/player-values";
const ESPN_PROJECTIONS = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const STATHEAD_PROJECTIONS = "https://raw.githubusercontent.com/dachhack/stathead/claude/nfl-fantasy-workbench-6D1yd/public/data";
const GITHUB_OWNER = "christianhwill";
const GITHUB_REPO = "sleeper-dynasty-league";
const GITHUB_BRANCH = "main";
const BRIDGE_VERSION = "4.1-historical-league-intelligence";
const MAX_GITHUB_JSON_BYTES = 50 * 1024 * 1024;
const MAX_EXTERNAL_FEED_BYTES = 15 * 1024 * 1024;
const NFL_REGULAR_SEASON_WEEKS = 18;
const PROJECTION_BATCH_SIZE = 3;
const PROJECTION_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"]);
const ESPN_POSITION_BY_ID = Object.freeze({ 1: "QB", 2: "RB", 3: "WR", 4: "TE" });
const PROJECTION_SOURCE_NAMES = Object.freeze({
  sleeper: "Sleeper/RotoWire",
  espn: "ESPN",
  stathead: "StatHead open model"
});
const WRITE_ROUTE_PATHS = Object.freeze([
  "/bootstrap",
  "/rebuild-games",
  "/rebuild-league-intelligence",
  "/rebuild-ledger",
  "/rebuild-player-intelligence",
  "/rebuild-player-values",
  "/rebuild-picks",
  "/rebuild-power-rankings",
  "/rebuild-projections",
  "/rebuild-tendencies",
  "/snapshot",
  "/sync",
  "/sync-season"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "Sleeper Dynasty Sync",
          version: BRIDGE_VERSION,
          league_anchor_id: LEAGUE_ANCHOR_ID,
          auto_rollover_enabled: true,
          player_intelligence_enabled: true,
          league_intelligence_enabled: true,
          league_intelligence_file: "league-intelligence.json",
          weekly_projection_source: "three-source consensus",
          weekly_projection_sources: Object.values(PROJECTION_SOURCE_NAMES),
          dynasty_value_sources: [
            "FantasyCalc",
            "DynastyProcess/FantasyPros ECR",
            "Dynasty Dealer"
          ],
          active_league_route: "/chain",
          github_repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          github_token_configured: Boolean(env.GITHUB_TOKEN),
          write_auth_enabled: Boolean(env.DYNASTY_WRITE_PASSWORD),
          public_routes: ["/", "/health", "/chain"],
          protected_write_routes: WRITE_ROUTE_PATHS
        });
      }

      if (isWriteRoute(url.pathname)) {
        const authFailure = await authorizeWriteRequest(
          request,
          env.DYNASTY_WRITE_PASSWORD
        );
        if (authFailure) return authFailure;
      }

      if (!env.GITHUB_TOKEN) {
        return json({ ok: false, error: "GITHUB_TOKEN secret is not configured." }, 500);
      }

      if (url.pathname === "/chain") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const chain = await discoverLeagueChain(activeLeague.league_id);
        return json({ ok: true, active_league_id: String(activeLeague.league_id), chain });
      }

      if (url.pathname === "/sync") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await syncCurrentCoreToGitHub(
          String(activeLeague.league_id),
          env.GITHUB_TOKEN,
          activeLeague.auto_rollover_detected ? (activeLeague.resolved_chain || true) : null
        );
        return json({ ok: true, mode: "safe_current_sync", ...result });
      }

      if (url.pathname === "/snapshot") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const label = url.searchParams.get("label");
        const result = await createManualSnapshot(String(activeLeague.league_id), env.GITHUB_TOKEN, label);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-ledger") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildUnifiedHistory(env.GITHUB_TOKEN, String(activeLeague.league_id));
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-league-intelligence") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildLeagueIntelligence(
          env.GITHUB_TOKEN,
          String(activeLeague.league_id)
        );
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-picks") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildDraftPickOwnership(env.GITHUB_TOKEN, String(activeLeague.league_id));
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-tendencies") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildOwnerTendencies(env.GITHUB_TOKEN, String(activeLeague.league_id));
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-power-rankings") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildPowerRankings(env.GITHUB_TOKEN, String(activeLeague.league_id));
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-player-values") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildPlayerValues(
          env.GITHUB_TOKEN,
          String(activeLeague.league_id)
        );
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-projections") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const activeLeagueId = String(activeLeague.league_id);
        const season = String(activeLeague.season);
        const weekValue = url.searchParams.get("week");
        const batchValue = url.searchParams.get("batch");

        if (weekValue !== null) {
          const week = Number(weekValue);
          if (!Number.isInteger(week) || week < 1 || week > NFL_REGULAR_SEASON_WEEKS) {
            return json({ ok: false, error: "week must be an integer from 1 through 18." }, 400);
          }
          const weekResult = await rebuildWeeklyProjections(
            env.GITHUB_TOKEN,
            activeLeagueId,
            week
          );
          const summary = await rebuildProjectionSummary(
            env.GITHUB_TOKEN,
            activeLeagueId
          );
          return json({ ok: true, mode: "week", week_result: weekResult, summary });
        }

        if (batchValue !== null) {
          const batch = Number(batchValue);
          const batchCount = NFL_REGULAR_SEASON_WEEKS / PROJECTION_BATCH_SIZE;
          if (!Number.isInteger(batch) || batch < 1 || batch > batchCount) {
            return json({ ok: false, error: `batch must be an integer from 1 through ${batchCount}.` }, 400);
          }
          const currentDoc = await getGitHubJSON("current.json", env.GITHUB_TOKEN);
          const sharedProjectionFeeds = await fetchSharedProjectionFeeds(season);
          const weeks = projectionWeeksForBatch(batch - 1);
          const weekResults = [];
          for (const week of weeks) {
            weekResults.push(await rebuildWeeklyProjections(
              env.GITHUB_TOKEN,
              activeLeagueId,
              week,
              currentDoc,
              sharedProjectionFeeds
            ));
          }
          const summary = await rebuildProjectionSummary(
            env.GITHUB_TOKEN,
            activeLeagueId,
            currentDoc
          );
          return json({ ok: true, mode: "batch", batch, weeks, week_results: weekResults, summary });
        }

        if (url.searchParams.get("season") === "1") {
          const seasonResult = await rebuildSeasonProjections(
            env.GITHUB_TOKEN,
            activeLeagueId
          );
          const summary = await rebuildProjectionSummary(
            env.GITHUB_TOKEN,
            activeLeagueId
          );
          return json({ ok: true, mode: "season", season_result: seasonResult, summary });
        }

        if (url.searchParams.get("finalize") === "1") {
          const summary = await rebuildProjectionSummary(
            env.GITHUB_TOKEN,
            activeLeagueId
          );
          return json({ ok: true, mode: "finalize", summary });
        }

        return json({
          ok: true,
          message: "Projection refreshes are split into bounded jobs. Automatic maintenance keeps these files current without Apple Shortcuts.",
          season,
          steps: [
            "/rebuild-projections?season=1",
            ...Array.from(
              { length: NFL_REGULAR_SEASON_WEEKS / PROJECTION_BATCH_SIZE },
              (_, index) => `/rebuild-projections?batch=${index + 1}`
            ),
            "/rebuild-projections?finalize=1"
          ]
        });
      }

      if (url.pathname === "/rebuild-player-intelligence") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const result = await rebuildPlayerIntelligence(
          env.GITHUB_TOKEN,
          String(activeLeague.league_id),
          activeLeague.resolved_chain || null
        );
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-games") {
        const season = url.searchParams.get("season");
        const finalize = url.searchParams.get("finalize") === "1";

        if (finalize) {
          const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
          const chain = await discoverLeagueChain(activeLeague.league_id);
          const result = await rebuildStoredGameHistory(
            env.GITHUB_TOKEN,
            String(activeLeague.league_id),
            chain
          );
          return json({ ok: true, mode: "finalize", ...result });
        }

        if (!season) {
          const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
          const chain = await discoverLeagueChain(activeLeague.league_id);
          const seasons = [...chain].reverse().map(entry => String(entry.season));
          return json({
            ok: true,
            message: "Game history rebuild is intentionally split by season to stay within Cloudflare subrequest limits.",
            steps: seasons.map(value => `/rebuild-games?season=${value}`).concat(["/rebuild-games?finalize=1"])
          });
        }

        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const chain = await discoverLeagueChain(activeLeague.league_id);
        const result = await rebuildGameHistorySeason(
          season,
          env.GITHUB_TOKEN,
          String(activeLeague.league_id),
          chain
        );
        return json({ ok: true, mode: "season", ...result });
      }

      if (url.pathname === "/sync-season") {
        const leagueId = url.searchParams.get("league_id");
        if (!leagueId) {
          return json({ ok: false, error: "Missing league_id query parameter." }, 400);
        }
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const isCurrent = String(leagueId) === String(activeLeague.league_id);
        const result = isCurrent
          ? await syncCurrentCoreToGitHub(
              String(activeLeague.league_id),
              env.GITHUB_TOKEN,
              activeLeague.auto_rollover_detected ? (activeLeague.resolved_chain || true) : null
            )
          : await syncSeasonToGitHub(leagueId, env.GITHUB_TOKEN, false);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/bootstrap") {
        const activeLeague = await resolveActiveLeague(env.GITHUB_TOKEN);
        const chain = await discoverLeagueChain(activeLeague.league_id);
        await upsertGitHubJSON(
          "config/league-chain.json",
          { generated_at: new Date().toISOString(), chain },
          "Update Sleeper league chain",
          env.GITHUB_TOKEN
        );
        return json({
          ok: true,
          message: "League chain saved to GitHub. Sync each season with /sync-season?league_id=...",
          chain
        });
      }

      return json({
        ok: true,
        service: "Sleeper Dynasty Sync",
        version: BRIDGE_VERSION,
        authentication: {
          public_routes: ["/", "/health", "/chain"],
          protected_write_routes: WRITE_ROUTE_PATHS,
          accepted_authorization_schemes: ["Basic", "Bearer"],
          credentials_in_query_strings: false
        },
        routes: {
          health: "/health",
          discover_history: "/chain",
          save_history_chain: "/bootstrap",
          sync_current_season: "/sync",
          create_manual_snapshot: "/snapshot?label=OPTIONAL_LABEL",
          rebuild_unified_ledger: "/rebuild-ledger",
          rebuild_league_intelligence: "/rebuild-league-intelligence",
          rebuild_draft_pick_ownership: "/rebuild-picks",
          rebuild_owner_tendencies: "/rebuild-tendencies",
          rebuild_power_rankings: "/rebuild-power-rankings",
          rebuild_player_values: "/rebuild-player-values",
          rebuild_player_intelligence: "/rebuild-player-intelligence",
          rebuild_weekly_projection: "/rebuild-projections?week=1",
          rebuild_projection_batch: "/rebuild-projections?batch=1",
          rebuild_season_projection: "/rebuild-projections?season=1",
          finalize_projection_summary: "/rebuild-projections?finalize=1",
          rebuild_game_history: "/rebuild-games?season=YYYY",
          finalize_game_history: "/rebuild-games?finalize=1",
          sync_one_season: "/sync-season?league_id=LEAGUE_ID"
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "request_failed",
        path: url.pathname,
        error: message
      }));
      return json({ ok: false, error: message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) return;
    ctx.waitUntil(
      runScheduledMaintenance(event, env.GITHUB_TOKEN)
        .then(result => console.log(JSON.stringify({ event: "scheduled_maintenance", ...result })))
        .catch(error => console.error(JSON.stringify({
          event: "scheduled_maintenance_failed",
          error: error instanceof Error ? error.message : String(error)
        })))
    );
  }
};

function isWriteRoute(pathname) {
  return WRITE_ROUTE_PATHS.includes(pathname);
}

async function authorizeWriteRequest(request, expectedPassword) {
  if (typeof expectedPassword !== "string" || expectedPassword.length === 0) {
    return json({
      ok: false,
      error: "DYNASTY_WRITE_PASSWORD secret is not configured."
    }, 503);
  }

  const providedPassword = extractWritePassword(request.headers.get("Authorization"));
  const authorized = providedPassword !== null
    && await secretsMatch(providedPassword, expectedPassword);

  if (authorized) return null;

  return json({
    ok: false,
    error: "Authentication is required for this write route."
  }, 401, {
    "WWW-Authenticate": "Basic realm=\"Dynasty Desk\", charset=\"UTF-8\""
  });
}

function extractWritePassword(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;

  const bearerMatch = authorizationHeader.match(/^Bearer[ \t]+(.+)$/i);
  if (bearerMatch) return bearerMatch[1];

  const basicMatch = authorizationHeader.match(/^Basic[ \t]+([A-Za-z0-9+/=]+)$/i);
  if (!basicMatch) return null;

  try {
    const decoded = atob(basicMatch[1]);
    const separatorIndex = decoded.indexOf(":");
    return separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : null;
  } catch {
    return null;
  }
}

async function secretsMatch(provided, expected) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }

  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index++) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

async function resolveActiveLeague(githubToken) {
  let startingLeagueId = LEAGUE_ANCHOR_ID;
  const storedChainDoc = await getGitHubJSON("config/league-chain.json", githubToken);
  const storedChain = Array.isArray(storedChainDoc?.chain) ? [...storedChainDoc.chain] : [];
  const storedLatestLeagueId = storedChain[0]?.league_id;
  if (storedLatestLeagueId) startingLeagueId = String(storedLatestLeagueId);

  let activeLeague = await getJSON(`${SLEEPER}/league/${startingLeagueId}`);
  let activeLeagueId = String(activeLeague.league_id || startingLeagueId);
  const anchorSeason = Number(activeLeague.season);
  const finalSeasonToCheck = Math.max(
    Number.isFinite(anchorSeason) ? anchorSeason + 1 : new Date().getUTCFullYear() + 1,
    new Date().getUTCFullYear() + 1
  );

  for (let season = (Number.isFinite(anchorSeason) ? anchorSeason : new Date().getUTCFullYear()) + 1;
    season <= finalSeasonToCheck;
    season += 1) {
    const leagues = await getJSON(
      `${SLEEPER}/user/${LEAGUE_ANCHOR_USER_ID}/leagues/nfl/${season}`
    );

    const matches = (Array.isArray(leagues) ? leagues : []).filter(league =>
      String(league.previous_league_id || "") === activeLeagueId
    );

    if (matches.length > 1) {
      throw new Error(`Multiple renewed Sleeper leagues point to ${activeLeagueId} for ${season}.`);
    }
    if (matches.length === 1) {
      activeLeague = matches[0];
      activeLeagueId = String(activeLeague.league_id);
      if (storedChain.length > 0 && !storedChain.some(entry => String(entry.league_id) === activeLeagueId)) {
        storedChain.unshift({
          season: String(activeLeague.season),
          league_id: activeLeagueId,
          name: activeLeague.name || null,
          previous_league_id: activeLeague.previous_league_id
            ? String(activeLeague.previous_league_id)
            : null,
          status: activeLeague.status || null
        });
      }
    }
  }

  return {
    ...activeLeague,
    auto_rollover_detected: activeLeagueId !== startingLeagueId,
    resolver_start_league_id: startingLeagueId,
    resolved_chain: storedChain.length > 0 ? storedChain : null
  };
}

async function discoverLeagueChain(startLeagueId) {
  const seen = new Set();
  const chain = [];
  let leagueId = startLeagueId;

  while (leagueId && leagueId !== "0" && !seen.has(leagueId) && chain.length < MAX_LEAGUE_CHAIN_LENGTH) {
    seen.add(leagueId);
    const league = await getJSON(`${SLEEPER}/league/${leagueId}`);
    chain.push({
      season: String(league.season),
      league_id: String(league.league_id),
      name: league.name || null,
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      status: league.status || null
    });
    leagueId = league.previous_league_id ? String(league.previous_league_id) : null;
  }

  return chain;
}

async function runScheduledMaintenance(event, githubToken) {
  const scheduledDate = new Date(event?.scheduledTime || Date.now());
  const utcHour = scheduledDate.getUTCHours();
  const utcDay = scheduledDate.getUTCDay();
  const activeLeague = await resolveActiveLeague(githubToken);
  const activeLeagueId = String(activeLeague.league_id);

  if (utcHour === 0 || utcHour === 12) {
    const result = await syncCurrentCoreToGitHub(
      activeLeagueId,
      githubToken,
      activeLeague.auto_rollover_detected ? (activeLeague.resolved_chain || true) : null
    );
    return { task: "current_core_sync", active_league_id: activeLeagueId, ...result };
  }

  if (utcHour === 3) {
    const chain = await discoverLeagueChain(activeLeagueId);
    const unifiedHistory = await rebuildUnifiedHistory(githubToken, activeLeagueId, chain);
    return {
      task: "daily_unified_history",
      active_league_id: activeLeagueId,
      unified_history: unifiedHistory
    };
  }

  if (utcDay === 0 && utcHour === 6) {
    const result = await syncCurrentDraftsToGitHub(activeLeagueId, githubToken);
    return { task: "weekly_draft_sync", active_league_id: activeLeagueId, ...result };
  }

  if (utcHour === 6) {
    const chain = await discoverLeagueChain(activeLeagueId);
    const ownerTendencies = await rebuildOwnerTendencies(githubToken, activeLeagueId, chain);
    return {
      task: "daily_owner_tendencies",
      active_league_id: activeLeagueId,
      owner_tendencies: ownerTendencies
    };
  }

  if (utcDay === 2 && utcHour === 9) {
    const nflState = await getJSON(`${SLEEPER}/state/nfl`);
    const sameSeason = String(nflState?.season || "") === String(activeLeague.season || "");
    const seasonType = String(nflState?.season_type || "").toLowerCase();
    const gamesAreActive = sameSeason && (seasonType === "regular" || seasonType === "post");

    if (!gamesAreActive) {
      return {
        task: "weekly_current_game_sync",
        active_league_id: activeLeagueId,
        skipped: true,
        reason: "The active Sleeper season is not in regular-season or postseason play."
      };
    }

    const chain = await discoverLeagueChain(activeLeagueId);
    const seasonResult = await rebuildGameHistorySeason(
      String(activeLeague.season),
      githubToken,
      activeLeagueId,
      chain
    );
    return {
      task: "weekly_current_game_sync",
      active_league_id: activeLeagueId,
      season_result: seasonResult
    };
  }

  if (utcHour === 9) {
    const playerIntelligence = await rebuildPlayerIntelligence(
      githubToken,
      activeLeagueId,
      activeLeague.resolved_chain || null
    );
    return {
      task: "daily_player_intelligence",
      active_league_id: activeLeagueId,
      player_intelligence: playerIntelligence
    };
  }

  if (utcHour === 15) {
    let gameHistoryRefresh = null;

    if (utcDay === 2) {
      const nflState = await getJSON(`${SLEEPER}/state/nfl`);
      const sameSeason = String(nflState?.season || "") === String(activeLeague.season || "");
      const seasonType = String(nflState?.season_type || "").toLowerCase();
      const gamesAreActive = sameSeason && (seasonType === "regular" || seasonType === "post");

      if (gamesAreActive) {
        const chain = await discoverLeagueChain(activeLeagueId);
        gameHistoryRefresh = await rebuildStoredGameHistory(
          githubToken,
          activeLeagueId,
          chain
        );
      } else {
        gameHistoryRefresh = {
          skipped: true,
          reason: "The active Sleeper season is not in regular-season or postseason play."
        };
      }
    }

    const leagueIntelligence = await rebuildLeagueIntelligence(
      githubToken,
      activeLeagueId
    );
    return {
      task: utcDay === 2
        ? "weekly_game_history_and_league_intelligence"
        : "daily_league_intelligence",
      active_league_id: activeLeagueId,
      game_history_refresh: gameHistoryRefresh,
      league_intelligence: leagueIntelligence
    };
  }

  if (utcHour === 18 || utcHour === 21) {
    const weeks = rotatingProjectionWeeks(scheduledDate, utcHour === 21 ? 1 : 0);
    const currentDoc = await getGitHubJSON("current.json", githubToken);
    const season = String(currentDoc?.season || currentDoc?.league?.season || activeLeague.season || "");
    const sharedProjectionFeeds = await fetchSharedProjectionFeeds(season);
    const weekResults = [];
    for (const week of weeks) {
      weekResults.push(await rebuildWeeklyProjections(
        githubToken,
        activeLeagueId,
        week,
        currentDoc,
        sharedProjectionFeeds
      ));
    }
    const summary = await rebuildProjectionSummary(
      githubToken,
      activeLeagueId,
      currentDoc
    );
    return {
      task: "rotating_weekly_projection_refresh",
      active_league_id: activeLeagueId,
      weeks,
      week_results: weekResults,
      summary
    };
  }

  return {
    task: "scheduled_noop",
    active_league_id: activeLeagueId,
    utc_hour: utcHour,
    utc_day: utcDay
  };
}

function rotatingProjectionWeeks(date, dailyOffset) {
  const dayIndex = Math.floor(date.getTime() / 86400000);
  const batchCount = NFL_REGULAR_SEASON_WEEKS / PROJECTION_BATCH_SIZE;
  const batchIndex = (dayIndex * 2 + dailyOffset) % batchCount;
  return projectionWeeksForBatch(batchIndex);
}

function projectionWeeksForBatch(batchIndex) {
  const firstWeek = batchIndex * PROJECTION_BATCH_SIZE + 1;
  return Array.from(
    { length: PROJECTION_BATCH_SIZE },
    (_, index) => firstWeek + index
  ).filter(week => week <= NFL_REGULAR_SEASON_WEEKS);
}

async function syncCurrentCoreToGitHub(leagueId, githubToken, refreshedLeagueChain = null) {
  const players = await getPlayers();
  const [league, users, rosters, tradedPicks] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/traded_picks`)
  ]);
  const userById = Object.fromEntries(users.map(user => [user.user_id, user]));
  const rosterById = Object.fromEntries(rosters.map(roster => [String(roster.roster_id), roster]));

  const transactionWeeks = Array.from({ length: 19 }, (_, index) => index);
  const transactionGroups = await Promise.all(transactionWeeks.map(async week => {
    try {
      const rows = await getJSON(`${SLEEPER}/league/${leagueId}/transactions/${week}`);
      return rows.map(transaction => ({ ...transaction, sleeper_week: week }));
    } catch {
      return [];
    }
  }));
  const transactions = dedupeById(transactionGroups.flat(), "transaction_id")
    .sort((a, b) => (a.created || 0) - (b.created || 0))
    .map(transaction => normalizeTransaction(transaction, players, rosterById, userById));
  const trades = transactions.filter(transaction => transaction.type === "trade");
  const teams = buildTeams(rosters, userById, players);
  const normalizedTradedPicks = tradedPicks.map(pick => normalizePick(pick, rosterById, userById));
  const draftPickOwnership = buildDraftPickOwnership(
    league,
    rosters,
    tradedPicks,
    rosterById,
    userById
  );
  const generatedAt = new Date().toISOString();
  const season = String(league.season);
  const seasonDir = `history/${season}`;
  const leagueSummary = {
    league_id: String(league.league_id),
    previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
    name: league.name,
    season,
    status: league.status,
    total_rosters: league.total_rosters,
    settings: league.settings,
    scoring_settings: league.scoring_settings,
    roster_positions: league.roster_positions,
    draft_id: league.draft_id ? String(league.draft_id) : null
  };
  const files = [
    [`${seasonDir}/league.json`, { generated_at: generatedAt, league: leagueSummary }],
    [`${seasonDir}/teams.json`, { generated_at: generatedAt, season, teams }],
    [`${seasonDir}/transactions.json`, { generated_at: generatedAt, season, transactions }],
    [`${seasonDir}/trades.json`, { generated_at: generatedAt, season, trades }],
    [`${seasonDir}/traded-picks.json`, {
      generated_at: generatedAt,
      season,
      traded_picks: normalizedTradedPicks
    }]
  ];

  for (const [path, data] of files) {
    await upsertGitHubJSON(path, data, `Sync Sleeper ${season}: ${path.split("/").pop()}`, githubToken);
  }

  await upsertGitHubJSON(
    "current.json",
    {
      generated_at: generatedAt,
      season,
      league: leagueSummary,
      teams,
      traded_picks: normalizedTradedPicks,
      draft_pick_ownership: draftPickOwnership,
      recent_transactions: transactions.slice(-100).reverse()
    },
    `Update live Sleeper snapshot (${season})`,
    githubToken
  );

  const draftPickOwnershipResult = await writeDraftPickOwnershipFile({
    league,
    rosters,
    tradedPicks,
    rosterById,
    userById,
    githubToken,
    generatedAt
  });

  const localDate = dateInTimeZone(new Date(), "America/Chicago");
  const dailySnapshotPath = `snapshots/${season}/daily/${localDate}.json`;
  const dailySnapshotResult = await createGitHubJSONIfMissing(
    dailySnapshotPath,
    buildSnapshotPayload({
      snapshotType: "daily",
      generatedAt,
      localDate,
      leagueSummary,
      teams,
      tradedPicks: normalizedTradedPicks,
      draftPickOwnership
    }),
    `Create daily Sleeper snapshot ${localDate}`,
    githubToken
  );

  let leagueChainFile = null;
  if (refreshedLeagueChain) {
    const chain = Array.isArray(refreshedLeagueChain)
      ? refreshedLeagueChain
      : await discoverLeagueChain(leagueId);
    await upsertGitHubJSON(
      "config/league-chain.json",
      { generated_at: generatedAt, chain },
      `Advance Sleeper league chain to ${season}`,
      githubToken
    );
    leagueChainFile = {
      path: "config/league-chain.json",
      seasons: chain.map(entry => String(entry.season))
    };
  }

  return {
    season,
    league_id: String(league.league_id),
    files_written: files.map(([path]) => path).concat(["current.json", "draft-pick-ownership.json"]),
    transaction_count: transactions.length,
    trade_count: trades.length,
    team_count: teams.length,
    daily_snapshot: dailySnapshotResult,
    draft_pick_ownership_file: draftPickOwnershipResult,
    league_chain_file: leagueChainFile
  };
}

async function syncCurrentDraftsToGitHub(leagueId, githubToken) {
  const players = await getPlayers();
  const [league, users, rosters, drafts] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/drafts`)
  ]);
  const userById = Object.fromEntries(users.map(user => [user.user_id, user]));
  const rosterById = Object.fromEntries(rosters.map(roster => [String(roster.roster_id), roster]));
  const draftData = [];

  for (const draft of drafts) {
    let picks = [];
    let tradedPicks = [];
    try { picks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/picks`); } catch {}
    try { tradedPicks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/traded_picks`); } catch {}
    draftData.push({
      draft_id: String(draft.draft_id),
      season: String(draft.season),
      status: draft.status,
      type: draft.type,
      settings: draft.settings || {},
      metadata: draft.metadata || {},
      slot_to_roster_id: draft.slot_to_roster_id || {},
      picks: picks.map(pick => ({
        ...pick,
        player: playerInfo(pick.player_id, players),
        roster_name: teamName(pick.roster_id, rosterById, userById)
      })),
      traded_picks: tradedPicks.map(pick => normalizePick(pick, rosterById, userById))
    });
  }

  const season = String(league.season);
  const path = `history/${season}/drafts.json`;
  await upsertGitHubJSON(
    path,
    { generated_at: new Date().toISOString(), season, drafts: draftData },
    `Sync Sleeper ${season}: drafts.json`,
    githubToken
  );
  return { season, league_id: String(league.league_id), path, draft_count: draftData.length };
}

async function syncSeasonToGitHub(leagueId, githubToken, isCurrent) {
  const players = await getPlayers();

  const [league, users, rosters, tradedPicks, drafts] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/traded_picks`),
    getJSON(`${SLEEPER}/league/${leagueId}/drafts`)
  ]);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));

  // Sleeper transaction endpoints are week/round based. Query 0-18 to include
  // preseason/offseason-style buckets plus all regular-season weeks.
  const transactionWeeks = Array.from({ length: 19 }, (_, i) => i);
  const txGroups = await Promise.all(transactionWeeks.map(async week => {
    try {
      const txs = await getJSON(`${SLEEPER}/league/${leagueId}/transactions/${week}`);
      return txs.map(tx => ({ ...tx, sleeper_week: week }));
    } catch {
      return [];
    }
  }));

  const transactionsRaw = dedupeById(txGroups.flat(), "transaction_id")
    .sort((a, b) => (a.created || 0) - (b.created || 0));

  const transactions = transactionsRaw.map(tx =>
    normalizeTransaction(tx, players, rosterById, userById)
  );

  const trades = transactions.filter(tx => tx.type === "trade");

  const draftData = [];
  for (const draft of drafts) {
    let picks = [];
    let draftTradedPicks = [];
    try { picks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/picks`); } catch {}
    try { draftTradedPicks = await getJSON(`${SLEEPER}/draft/${draft.draft_id}/traded_picks`); } catch {}

    draftData.push({
      draft_id: String(draft.draft_id),
      season: String(draft.season),
      status: draft.status,
      type: draft.type,
      settings: draft.settings || {},
      metadata: draft.metadata || {},
      slot_to_roster_id: draft.slot_to_roster_id || {},
      picks: picks.map(p => ({
        ...p,
        player: playerInfo(p.player_id, players),
        roster_name: teamName(p.roster_id, rosterById, userById)
      })),
      traded_picks: draftTradedPicks.map(p => normalizePick(p, rosterById, userById))
    });
  }

  const teams = buildTeams(rosters, userById, players);
  const draftPickOwnership = buildDraftPickOwnership(league, rosters, tradedPicks, rosterById, userById);
  const seasonGames = await fetchSeasonGameData(leagueId, league, rosterById, userById, players);

  const season = String(league.season);
  const seasonDir = `history/${season}`;
  const generatedAt = new Date().toISOString();

  const leagueSummary = {
    generated_at: generatedAt,
    league: {
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      name: league.name,
      season,
      status: league.status,
      total_rosters: league.total_rosters,
      settings: league.settings,
      scoring_settings: league.scoring_settings,
      roster_positions: league.roster_positions,
      draft_id: league.draft_id ? String(league.draft_id) : null
    }
  };

  const files = [
    [`${seasonDir}/league.json`, leagueSummary],
    [`${seasonDir}/teams.json`, { generated_at: generatedAt, season, teams }],
    [`${seasonDir}/transactions.json`, { generated_at: generatedAt, season, transactions }],
    [`${seasonDir}/trades.json`, { generated_at: generatedAt, season, trades }],
    [`${seasonDir}/traded-picks.json`, {
      generated_at: generatedAt,
      season,
      traded_picks: tradedPicks.map(p => normalizePick(p, rosterById, userById))
    }],
    [`${seasonDir}/drafts.json`, { generated_at: generatedAt, season, drafts: draftData }],
    [`${seasonDir}/matchups.json`, {
      generated_at: generatedAt,
      season,
      league_id: String(league.league_id),
      playoff_week_start: Number(league.settings?.playoff_week_start || 15),
      weeks: seasonGames.weeks
    }],
    [`${seasonDir}/playoffs.json`, {
      generated_at: generatedAt,
      season,
      league_id: String(league.league_id),
      playoff_week_start: Number(league.settings?.playoff_week_start || 15),
      winners_bracket: seasonGames.winners_bracket,
      losers_bracket: seasonGames.losers_bracket
    }]
  ];

  // Write serially to avoid GitHub contents API conflicts.
  for (const [path, data] of files) {
    await upsertGitHubJSON(path, data, `Sync Sleeper ${season}: ${path.split("/").pop()}`, githubToken);
  }

  if (isCurrent) {
    await upsertGitHubJSON(
      "current.json",
      {
        generated_at: generatedAt,
        season,
        league: leagueSummary.league,
        teams,
        traded_picks: tradedPicks.map(p => normalizePick(p, rosterById, userById)),
        draft_pick_ownership: draftPickOwnership,
        recent_transactions: transactions.slice(-100).reverse()
      },
      `Update live Sleeper snapshot (${season})`,
      githubToken
    );

    const draftPickOwnershipResult = await writeDraftPickOwnershipFile({
      league,
      rosters,
      tradedPicks,
      rosterById,
      userById,
      githubToken,
      generatedAt
    });

    const localDate = dateInTimeZone(new Date(), "America/Chicago");
    const dailySnapshotPath = `snapshots/${season}/daily/${localDate}.json`;
    const dailySnapshot = buildSnapshotPayload({
      snapshotType: "daily",
      generatedAt,
      localDate,
      leagueSummary: leagueSummary.league,
      teams,
      tradedPicks: tradedPicks.map(p => normalizePick(p, rosterById, userById)),
      draftPickOwnership
    });
    const dailySnapshotResult = await createGitHubJSONIfMissing(
      dailySnapshotPath,
      dailySnapshot,
      `Create daily Sleeper snapshot ${localDate}`,
      githubToken
    );

    const unifiedHistory = await rebuildUnifiedHistory(githubToken, leagueId);
    const ownerTendencies = await rebuildOwnerTendencies(githubToken, leagueId);
    const powerRankings = await rebuildPowerRankings(githubToken, leagueId);
    const gameHistory = await rebuildStoredGameHistory(githubToken, leagueId);
    const leagueIntelligence = await rebuildLeagueIntelligence(githubToken, leagueId);

    return {
      season,
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      files_written: files.map(([path]) => path).concat([
        "current.json",
        "draft-pick-ownership.json",
        "owner-tendencies.json",
        "power-rankings.json",
        "game-history.json",
        "playoff-history.json",
        "league-intelligence.json"
      ]),
      transaction_count: transactions.length,
      trade_count: trades.length,
      draft_count: draftData.length,
      team_count: teams.length,
      daily_snapshot: dailySnapshotResult,
      draft_pick_ownership_file: draftPickOwnershipResult,
      unified_history: unifiedHistory,
      owner_tendencies: ownerTendencies,
      power_rankings: powerRankings,
      game_history: gameHistory,
      league_intelligence: leagueIntelligence
    };
  }

  return {
    season,
    league_id: String(league.league_id),
    previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
    files_written: files.map(([path]) => path).concat(isCurrent ? ["current.json"] : []),
    transaction_count: transactions.length,
    trade_count: trades.length,
    draft_count: draftData.length,
    team_count: teams.length
  };
}


async function fetchSeasonGameData(leagueId, league, rosterById, userById, players) {
  const weeksToFetch = Array.from({ length: 18 }, (_, i) => i + 1);
  const playoffWeekStart = Number(league.settings?.playoff_week_start || 15);
  let nflState = null;
  try { nflState = await getJSON(`${SLEEPER}/state/nfl`); } catch {}

  const weekRows = await Promise.all(weeksToFetch.map(async week => {
    try {
      const raw = await getJSON(`${SLEEPER}/league/${leagueId}/matchups/${week}`);
      const completed = isFantasyWeekCompleted(String(league.season), week, nflState);
      return normalizeMatchupWeek(raw, week, playoffWeekStart, rosterById, userById, players, completed);
    } catch {
      return { week, phase: week >= playoffWeekStart ? "postseason" : "regular", is_completed: false, teams: [], games: [] };
    }
  }));

  let winners = [];
  let losers = [];
  try { winners = await getJSON(`${SLEEPER}/league/${leagueId}/winners_bracket`); } catch {}
  try { losers = await getJSON(`${SLEEPER}/league/${leagueId}/losers_bracket`); } catch {}

  return {
    weeks: weekRows,
    winners_bracket: normalizeBracket(winners, rosterById, userById),
    losers_bracket: normalizeBracket(losers, rosterById, userById)
  };
}

function isFantasyWeekCompleted(season, week, nflState) {
  if (!nflState) return false;
  const targetSeason = Number(season);
  const stateSeason = Number(nflState.season);
  if (targetSeason < stateSeason) return true;
  if (targetSeason > stateSeason) return false;

  const seasonType = String(nflState.season_type || "").toLowerCase();
  if (seasonType === "post") return true;
  if (seasonType !== "regular") return false;
  return Number(week) < Number(nflState.week || 0);
}

function normalizeMatchupWeek(rawRows, week, playoffWeekStart, rosterById, userById, players, isCompleted) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const teams = rows.map(row => {
    const playerPoints = row.players_points && typeof row.players_points === "object"
      ? row.players_points
      : {};
    const starters = Array.isArray(row.starters) ? row.starters : [];
    const starterPoints = Array.isArray(row.starters_points) ? row.starters_points : [];
    const allPlayers = Array.isArray(row.players) ? row.players : [];

    return {
      roster_id: Number(row.roster_id),
      team_name: teamName(row.roster_id, rosterById, userById),
      matchup_id: row.matchup_id ?? null,
      points: row.points ?? null,
      custom_points: row.custom_points ?? null,
      starters: starters.map((id, idx) => ({
        ...playerInfo(id, players),
        fantasy_points: playerPoints[id] ?? starterPoints[idx] ?? null
      })),
      players: allPlayers.map(id => ({
        ...playerInfo(id, players),
        fantasy_points: playerPoints[id] ?? null,
        started: starters.includes(id)
      }))
    };
  });

  const grouped = new Map();
  for (const team of teams) {
    const key = String(team.matchup_id ?? `roster-${team.roster_id}`);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(team);
  }

  const games = [];
  for (const [matchupKey, sides] of grouped.entries()) {
    if (sides.length < 2) continue;
    const ordered = [...sides].sort((a, b) => a.roster_id - b.roster_id);
    const a = ordered[0];
    const b = ordered[1];
    const aPts = Number(a.points);
    const bPts = Number(b.points);
    const pointsAreNumeric = a.points != null && b.points != null && Number.isFinite(aPts) && Number.isFinite(bPts);
    const winnerRosterId = isCompleted && pointsAreNumeric && aPts !== bPts
      ? (aPts > bPts ? a.roster_id : b.roster_id)
      : null;

    games.push({
      matchup_id: a.matchup_id ?? b.matchup_id ?? matchupKey,
      phase: week >= playoffWeekStart ? "postseason" : "regular",
      is_completed: Boolean(isCompleted),
      team_1: a,
      team_2: b,
      winner_roster_id: winnerRosterId,
      winner_team: winnerRosterId ? (winnerRosterId === a.roster_id ? a.team_name : b.team_name) : null,
      margin: isCompleted && pointsAreNumeric ? Math.round(Math.abs(aPts - bPts) * 100) / 100 : null,
      tie: isCompleted && pointsAreNumeric ? aPts === bPts : false
    });
  }

  return {
    week,
    phase: week >= playoffWeekStart ? "postseason" : "regular",
    is_completed: Boolean(isCompleted),
    teams,
    games
  };
}

function normalizeBracket(rows, rosterById, userById) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    round: row.r ?? null,
    match_id: row.m ?? null,
    team_1_roster_id: typeof row.t1 === "number" ? row.t1 : null,
    team_1: typeof row.t1 === "number" ? teamName(row.t1, rosterById, userById) : null,
    team_2_roster_id: typeof row.t2 === "number" ? row.t2 : null,
    team_2: typeof row.t2 === "number" ? teamName(row.t2, rosterById, userById) : null,
    team_1_from: row.t1_from ?? (row.t1 && typeof row.t1 === "object" ? row.t1 : null),
    team_2_from: row.t2_from ?? (row.t2 && typeof row.t2 === "object" ? row.t2 : null),
    winner_roster_id: row.w ?? null,
    winner_team: row.w ? teamName(row.w, rosterById, userById) : null,
    loser_roster_id: row.l ?? null,
    loser_team: row.l ? teamName(row.l, rosterById, userById) : null,
    placement: row.p ?? null
  }));
}

async function rebuildGameHistorySeason(requestedSeason, githubToken, activeLeagueId, providedChain = null) {
  const season = String(requestedSeason);
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const entry = chainNewestFirst.find(item => String(item.season) === season);

  if (!entry) {
    throw new Error(`Season ${season} is not in the discovered Sleeper league chain.`);
  }

  const leagueId = String(entry.league_id);
  const players = await getPlayers();
  const [league, users, rosters] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`)
  ]);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));
  const data = await fetchSeasonGameData(leagueId, league, rosterById, userById, players);
  const generatedAt = new Date().toISOString();

  await upsertGitHubJSON(
    `history/${season}/matchups.json`,
    {
      generated_at: generatedAt,
      season,
      league_id: leagueId,
      playoff_week_start: Number(league.settings?.playoff_week_start || 15),
      weeks: data.weeks
    },
    `Rebuild Sleeper ${season} matchup history`,
    githubToken
  );

  await upsertGitHubJSON(
    `history/${season}/playoffs.json`,
    {
      generated_at: generatedAt,
      season,
      league_id: leagueId,
      playoff_week_start: Number(league.settings?.playoff_week_start || 15),
      winners_bracket: data.winners_bracket,
      losers_bracket: data.losers_bracket
    },
    `Rebuild Sleeper ${season} playoff brackets`,
    githubToken
  );

  return {
    season,
    league_id: leagueId,
    matchup_file: `history/${season}/matchups.json`,
    playoff_file: `history/${season}/playoffs.json`,
    matchup_weeks: data.weeks.filter(w => w.games.length > 0).length,
    games: data.weeks.reduce((n, w) => n + w.games.length, 0),
    winners_bracket_matches: data.winners_bracket.length,
    losers_bracket_matches: data.losers_bracket.length
  };
}

async function rebuildStoredGameHistory(githubToken, activeLeagueId, providedChain = null) {
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const chain = [...chainNewestFirst].reverse();
  const allGames = [];
  const playoffSeasons = [];
  const seasonSummary = [];

  for (const entry of chain) {
    const season = String(entry.season);
    const [matchupsDoc, playoffsDoc] = await Promise.all([
      getGitHubJSON(`history/${season}/matchups.json`, githubToken),
      getGitHubJSON(`history/${season}/playoffs.json`, githubToken)
    ]);
    if (!matchupsDoc) continue;

    let count = 0;
    for (const week of (matchupsDoc.weeks || [])) {
      for (const game of (week.games || [])) {
        allGames.push({
          season,
          league_id: String(entry.league_id),
          week: Number(week.week),
          phase: game.phase || week.phase || "regular",
          ...game
        });
        count += 1;
      }
    }
    seasonSummary.push({ season, league_id: String(entry.league_id), game_count: count });
    playoffSeasons.push({
      season,
      league_id: String(entry.league_id),
      playoff_week_start: playoffsDoc?.playoff_week_start ?? null,
      winners_bracket: playoffsDoc?.winners_bracket || [],
      losers_bracket: playoffsDoc?.losers_bracket || []
    });
  }

  allGames.sort((a, b) => Number(a.season) - Number(b.season) || a.week - b.week || Number(a.matchup_id || 0) - Number(b.matchup_id || 0));
  const headToHead = buildHeadToHead(allGames);
  const generatedAt = new Date().toISOString();

  await upsertGitHubJSON(
    "game-history.json",
    { generated_at: generatedAt, seasons: seasonSummary, game_count: allGames.length, games: allGames, head_to_head: headToHead },
    "Update unified Sleeper game history",
    githubToken
  );
  await upsertGitHubJSON(
    "playoff-history.json",
    { generated_at: generatedAt, seasons: playoffSeasons },
    "Update Sleeper playoff history",
    githubToken
  );

  return {
    game_history_file: "game-history.json",
    playoff_history_file: "playoff-history.json",
    seasons_included: seasonSummary.map(s => s.season),
    game_count: allGames.length,
    head_to_head_pairs: headToHead.length
  };
}

function buildHeadToHead(games) {
  const map = new Map();
  for (const game of games) {
    if (!game.is_completed) continue;
    const a = game.team_1;
    const b = game.team_2;
    if (!a || !b) continue;
    const ids = [Number(a.roster_id), Number(b.roster_id)].sort((x, y) => x - y);
    const key = ids.join("-");
    if (!map.has(key)) {
      map.set(key, {
        roster_id_1: ids[0],
        roster_id_2: ids[1],
        team_1: Number(a.roster_id) === ids[0] ? a.team_name : b.team_name,
        team_2: Number(a.roster_id) === ids[1] ? a.team_name : b.team_name,
        games: 0,
        wins_1: 0,
        wins_2: 0,
        ties: 0,
        points_1: 0,
        points_2: 0,
        meetings: []
      });
    }
    const h = map.get(key);
    const first = Number(a.roster_id) === ids[0] ? a : b;
    const second = Number(a.roster_id) === ids[0] ? b : a;
    const p1 = Number(first.points);
    const p2 = Number(second.points);
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue;
    h.games += 1;
    h.points_1 += p1;
    h.points_2 += p2;
    if (p1 > p2) h.wins_1 += 1;
    else if (p2 > p1) h.wins_2 += 1;
    else h.ties += 1;
    h.meetings.push({ season: game.season, week: game.week, phase: game.phase, points_1: p1, points_2: p2, winner_roster_id: game.winner_roster_id });
  }
  return [...map.values()].map(h => ({
    ...h,
    points_1: Math.round(h.points_1 * 100) / 100,
    points_2: Math.round(h.points_2 * 100) / 100
  })).sort((a, b) => b.games - a.games || a.roster_id_1 - b.roster_id_1 || a.roster_id_2 - b.roster_id_2);
}


async function rebuildUnifiedHistory(githubToken, activeLeagueId, providedChain = null) {
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const chain = [...chainNewestFirst].reverse();
  const allTransactions = [];
  const allTrades = [];
  const seasons = [];

  for (const leagueEntry of chain) {
    const season = String(leagueEntry.season);
    const [transactionDoc, tradeDoc] = await Promise.all([
      getGitHubJSON(`history/${season}/transactions.json`, githubToken),
      getGitHubJSON(`history/${season}/trades.json`, githubToken)
    ]);

    const seasonTransactions = Array.isArray(transactionDoc?.transactions)
      ? transactionDoc.transactions
      : [];
    const seasonTrades = Array.isArray(tradeDoc?.trades)
      ? tradeDoc.trades
      : [];

    allTransactions.push(...seasonTransactions.map(tx => ({
      ...tx,
      season,
      league_id: String(leagueEntry.league_id)
    })));

    allTrades.push(...seasonTrades.map(trade => ({
      ...trade,
      season,
      league_id: String(leagueEntry.league_id)
    })));

    seasons.push({
      season,
      league_id: String(leagueEntry.league_id),
      transaction_count: seasonTransactions.length,
      trade_count: seasonTrades.length
    });
  }

  const transactions = dedupeById(allTransactions, "transaction_id")
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const trades = dedupeById(allTrades, "transaction_id")
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const generatedAt = new Date().toISOString();

  const transactionPath = "history/all-transactions.json";
  const tradePath = "history/all-trades.json";

  await upsertGitHubJSON(
    transactionPath,
    {
      generated_at: generatedAt,
      league_name: chainNewestFirst[0]?.name || null,
      seasons,
      transaction_count: transactions.length,
      transactions
    },
    "Rebuild unified Sleeper transaction history",
    githubToken
  );

  await upsertGitHubJSON(
    tradePath,
    {
      generated_at: generatedAt,
      league_name: chainNewestFirst[0]?.name || null,
      seasons,
      trade_count: trades.length,
      trades
    },
    "Rebuild unified Sleeper trade history",
    githubToken
  );

  return {
    transaction_path: transactionPath,
    trade_path: tradePath,
    seasons: seasons.map(s => s.season),
    transaction_count: transactions.length,
    trade_count: trades.length
  };
}


async function rebuildOwnerTendencies(githubToken, activeLeagueId, providedChain = null) {
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const chain = [...chainNewestFirst].reverse();
  const [transactionDoc, pickDoc, ...teamDocs] = await Promise.all([
    getGitHubJSON("history/all-transactions.json", githubToken),
    getGitHubJSON("draft-pick-ownership.json", githubToken),
    ...chain.map(entry => getGitHubJSON(`history/${entry.season}/teams.json`, githubToken))
  ]);

  const transactions = Array.isArray(transactionDoc?.transactions)
    ? transactionDoc.transactions.filter(tx => tx?.status === "complete")
    : [];

  const seasonRosterToOwner = new Map();
  const owners = new Map();
  const ownerIdToKey = new Map();
  const currentSeason = String(chainNewestFirst[0]?.season || "");

  for (let i = 0; i < chain.length; i++) {
    const season = String(chain[i].season);
    const teams = Array.isArray(teamDocs[i]?.teams) ? teamDocs[i].teams : [];

    for (const team of teams) {
      const ownerKey = team.owner_id
        ? `user:${team.owner_id}`
        : `season:${season}:roster:${team.roster_id}`;
      const numericSeason = Number(season) || 0;
      seasonRosterToOwner.set(`${season}:${team.roster_id}`, ownerKey);
      if (team.owner_id) ownerIdToKey.set(String(team.owner_id), ownerKey);

      if (!owners.has(ownerKey)) {
        owners.set(ownerKey, makeOwnerTendencyRecord(ownerKey));
      }

      const record = owners.get(ownerKey);
      record.owner_id = team.owner_id || record.owner_id;
      record.username = team.username || record.username;
      record.display_name = team.display_name || record.display_name;
      record.seasons_active.add(season);
      record.team_names.add(team.team_name || `Roster ${team.roster_id}`);
      record.rosters_by_season[season] = team.roster_id;

      if (numericSeason >= record._latest_season_number) {
        record._latest_season_number = numericSeason;
        record.current_roster_id = team.roster_id;
        record.current_team_name = team.team_name || `Roster ${team.roster_id}`;
      }
    }
  }

  function ownerForRoster(season, rosterId) {
    return seasonRosterToOwner.get(`${season}:${rosterId}`) || null;
  }

  function getRecord(ownerKey) {
    return ownerKey ? owners.get(ownerKey) || null : null;
  }

  for (const tx of transactions) {
    const season = String(tx.season || "unknown");
    const rosterIds = [...new Set((tx.roster_ids || []).map(Number).filter(Number.isFinite))];
    const participantKeys = [...new Set(rosterIds.map(id => ownerForRoster(season, id)).filter(Boolean))];

    for (const ownerKey of participantKeys) {
      const record = getRecord(ownerKey);
      if (!record) continue;
      const bucket = ensureOwnerSeasonBucket(record, season);
      record.activity.transactions_involved += 1;
      bucket.transactions_involved += 1;
      record.activity.transaction_types[tx.type] = (record.activity.transaction_types[tx.type] || 0) + 1;
    }

    if (tx.type === "trade") {
      const creatorKey = tx.creator ? ownerIdToKey.get(String(tx.creator)) : null;
      const creatorRecord = getRecord(creatorKey);
      if (creatorRecord) {
        creatorRecord.trade_profile.trades_created += 1;
        ensureOwnerSeasonBucket(creatorRecord, season).trades_created += 1;
      }

      for (const rosterId of rosterIds) {
        const ownerKey = ownerForRoster(season, rosterId);
        const record = getRecord(ownerKey);
        if (!record) continue;
        const bucket = ensureOwnerSeasonBucket(record, season);
        record.trade_profile.trades += 1;
        bucket.trades += 1;

        for (const partnerRosterId of rosterIds) {
          if (partnerRosterId === rosterId) continue;
          const partnerKey = ownerForRoster(season, partnerRosterId);
          if (!partnerKey || partnerKey === ownerKey) continue;
          const partner = getRecord(partnerKey);
          if (!partner) continue;
          const partnerEntry = record._trade_partners.get(partnerKey) || {
            owner_key: partnerKey,
            owner_id: partner.owner_id,
            team_name: partner.current_team_name,
            trades: 0
          };
          partnerEntry.owner_id = partner.owner_id;
          partnerEntry.team_name = partner.current_team_name;
          partnerEntry.trades += 1;
          record._trade_partners.set(partnerKey, partnerEntry);
        }
      }

      for (const move of tx.adds || []) {
        const ownerKey = ownerForRoster(season, Number(move.roster_id));
        const record = getRecord(ownerKey);
        if (!record) continue;
        record.trade_profile.players_acquired += 1;
        incrementCounter(record.trade_profile.positions_acquired, move.player?.position || "UNKNOWN");
        ensureOwnerSeasonBucket(record, season).players_acquired += 1;
      }

      for (const move of tx.drops || []) {
        const ownerKey = ownerForRoster(season, Number(move.roster_id));
        const record = getRecord(ownerKey);
        if (!record) continue;
        record.trade_profile.players_sent += 1;
        incrementCounter(record.trade_profile.positions_sent, move.player?.position || "UNKNOWN");
        ensureOwnerSeasonBucket(record, season).players_sent += 1;
      }

      const ownersWithPickMovement = new Set();
      for (const pick of tx.draft_picks || []) {
        const previousRosterId = Number(pick.previous_owner_roster_id);
        const currentRosterId = Number(pick.current_owner_roster_id);
        const round = Number(pick.round);

        if (Number.isFinite(previousRosterId)) {
          const ownerKey = ownerForRoster(season, previousRosterId);
          const record = getRecord(ownerKey);
          if (record) {
            record.trade_profile.draft_picks_sent += 1;
            if (round === 1) record.trade_profile.firsts_sent += 1;
            else if (round === 2) record.trade_profile.seconds_sent += 1;
            else if (round === 3) record.trade_profile.thirds_sent += 1;
            const bucket = ensureOwnerSeasonBucket(record, season);
            bucket.draft_picks_sent += 1;
            if (round === 1) bucket.firsts_sent += 1;
            ownersWithPickMovement.add(ownerKey);
          }
        }

        if (Number.isFinite(currentRosterId)) {
          const ownerKey = ownerForRoster(season, currentRosterId);
          const record = getRecord(ownerKey);
          if (record) {
            record.trade_profile.draft_picks_acquired += 1;
            if (round === 1) record.trade_profile.firsts_acquired += 1;
            else if (round === 2) record.trade_profile.seconds_acquired += 1;
            else if (round === 3) record.trade_profile.thirds_acquired += 1;
            const bucket = ensureOwnerSeasonBucket(record, season);
            bucket.draft_picks_acquired += 1;
            if (round === 1) bucket.firsts_acquired += 1;
            ownersWithPickMovement.add(ownerKey);
          }
        }
      }

      for (const ownerKey of ownersWithPickMovement) {
        const record = getRecord(ownerKey);
        if (record) record.trade_profile.trades_involving_picks += 1;
      }

      const ownersWithPlayerMovement = new Set();
      for (const move of [...(tx.adds || []), ...(tx.drops || [])]) {
        const ownerKey = ownerForRoster(season, Number(move.roster_id));
        if (ownerKey) ownersWithPlayerMovement.add(ownerKey);
      }
      for (const ownerKey of ownersWithPlayerMovement) {
        const record = getRecord(ownerKey);
        if (record) record.trade_profile.trades_involving_players += 1;
      }
    }

    if (tx.type === "waiver") {
      for (const ownerKey of participantKeys) {
        const record = getRecord(ownerKey);
        if (!record) continue;
        const bucket = ensureOwnerSeasonBucket(record, season);
        record.activity.waiver_claims_won += 1;
        bucket.waiver_claims_won += 1;
        const bid = Number(tx.waiver_bid);
        if (Number.isFinite(bid) && bid >= 0) {
          record.activity.faab_spent += bid;
          record.activity.faab_bids.push(bid);
          bucket.faab_spent += bid;
        }
      }
    }

    if (tx.type === "free_agent") {
      for (const ownerKey of participantKeys) {
        const record = getRecord(ownerKey);
        if (!record) continue;
        record.activity.free_agent_transactions += 1;
        ensureOwnerSeasonBucket(record, season).free_agent_transactions += 1;
      }
    }

    for (const move of tx.adds || []) {
      const ownerKey = ownerForRoster(season, Number(move.roster_id));
      const record = getRecord(ownerKey);
      if (!record) continue;
      record.activity.player_adds += 1;
      ensureOwnerSeasonBucket(record, season).player_adds += 1;
    }

    for (const move of tx.drops || []) {
      const ownerKey = ownerForRoster(season, Number(move.roster_id));
      const record = getRecord(ownerKey);
      if (!record) continue;
      record.activity.player_drops += 1;
      ensureOwnerSeasonBucket(record, season).player_drops += 1;
    }
  }

  const currentPickByRoster = new Map(
    (pickDoc?.by_owner || []).map(row => [Number(row.roster_id), row])
  );

  for (const record of owners.values()) {
    const currentPicks = currentPickByRoster.get(Number(record.current_roster_id));
    if (currentPicks && record._latest_season_number === Number(currentSeason)) {
      record.current_draft_capital = {
        total_future_picks: currentPicks.total_future_picks || 0,
        first_round_picks: currentPicks.first_round_picks || 0,
        second_round_picks: currentPicks.second_round_picks || 0,
        third_round_picks: currentPicks.third_round_picks || 0,
        by_season: currentPicks.by_season || {}
      };
    }
  }

  const outputOwners = [...owners.values()].map(finalizeOwnerTendencyRecord);
  applyLeagueRanks(outputOwners);
  outputOwners.sort((a, b) =>
    (a.current_roster_id ?? 999) - (b.current_roster_id ?? 999) ||
    String(a.current_team_name).localeCompare(String(b.current_team_name))
  );

  const path = "owner-tendencies.json";
  const payload = {
    generated_at: new Date().toISOString(),
    league_name: chainNewestFirst[0]?.name || null,
    seasons: chain.map(entry => String(entry.season)),
    methodology: {
      completed_transactions_only: true,
      trade_count_definition: "Number of completed trades in which the owner participated.",
      trade_partners_definition: "Each other owner participating in the same completed trade.",
      faab_definition: "Sum of successful waiver transaction waiver_bid values when present.",
      pick_flow_definition: "Draft picks are counted as sent from previous_owner_roster_id and acquired by current_owner_roster_id.",
      rankings: "1 is highest activity or largest current draft-capital total for that metric. Ties share the same rank."
    },
    owner_count: outputOwners.length,
    owners: outputOwners
  };

  await upsertGitHubJSON(
    path,
    payload,
    "Update Sleeper owner tendency profiles",
    githubToken
  );

  return {
    path,
    seasons: payload.seasons,
    owner_count: outputOwners.length,
    completed_transaction_count_analyzed: transactions.length
  };
}

function makeOwnerTendencyRecord(ownerKey) {
  return {
    owner_key: ownerKey,
    owner_id: null,
    username: null,
    display_name: null,
    current_roster_id: null,
    current_team_name: null,
    _latest_season_number: 0,
    seasons_active: new Set(),
    team_names: new Set(),
    rosters_by_season: {},
    activity: {
      transactions_involved: 0,
      transaction_types: {},
      waiver_claims_won: 0,
      free_agent_transactions: 0,
      player_adds: 0,
      player_drops: 0,
      faab_spent: 0,
      faab_bids: []
    },
    trade_profile: {
      trades: 0,
      trades_created: 0,
      players_acquired: 0,
      players_sent: 0,
      positions_acquired: {},
      positions_sent: {},
      draft_picks_acquired: 0,
      draft_picks_sent: 0,
      firsts_acquired: 0,
      firsts_sent: 0,
      seconds_acquired: 0,
      seconds_sent: 0,
      thirds_acquired: 0,
      thirds_sent: 0,
      trades_involving_picks: 0,
      trades_involving_players: 0
    },
    current_draft_capital: {
      total_future_picks: 0,
      first_round_picks: 0,
      second_round_picks: 0,
      third_round_picks: 0,
      by_season: {}
    },
    by_season: {},
    _trade_partners: new Map(),
    league_ranks: {}
  };
}

function ensureOwnerSeasonBucket(record, season) {
  if (!record.by_season[season]) {
    record.by_season[season] = {
      transactions_involved: 0,
      trades: 0,
      trades_created: 0,
      waiver_claims_won: 0,
      free_agent_transactions: 0,
      faab_spent: 0,
      player_adds: 0,
      player_drops: 0,
      players_acquired: 0,
      players_sent: 0,
      draft_picks_acquired: 0,
      draft_picks_sent: 0,
      firsts_acquired: 0,
      firsts_sent: 0
    };
  }
  return record.by_season[season];
}

function incrementCounter(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

function finalizeOwnerTendencyRecord(record) {
  const bids = record.activity.faab_bids;
  const avgFaab = bids.length
    ? Number((bids.reduce((sum, value) => sum + value, 0) / bids.length).toFixed(2))
    : 0;
  const maxFaab = bids.length ? Math.max(...bids) : 0;
  const tradePartners = [...record._trade_partners.values()]
    .sort((a, b) => b.trades - a.trades || String(a.team_name).localeCompare(String(b.team_name)));

  return {
    owner_key: record.owner_key,
    owner_id: record.owner_id,
    username: record.username,
    display_name: record.display_name,
    current_roster_id: record.current_roster_id,
    current_team_name: record.current_team_name,
    seasons_active: [...record.seasons_active].sort(),
    team_names_used: [...record.team_names],
    rosters_by_season: record.rosters_by_season,
    activity: {
      transactions_involved: record.activity.transactions_involved,
      transaction_types: record.activity.transaction_types,
      waiver_claims_won: record.activity.waiver_claims_won,
      free_agent_transactions: record.activity.free_agent_transactions,
      player_adds: record.activity.player_adds,
      player_drops: record.activity.player_drops,
      faab_spent: record.activity.faab_spent,
      average_successful_faab_bid: avgFaab,
      max_successful_faab_bid: maxFaab
    },
    trade_profile: {
      ...record.trade_profile,
      net_draft_picks: record.trade_profile.draft_picks_acquired - record.trade_profile.draft_picks_sent,
      net_first_round_picks: record.trade_profile.firsts_acquired - record.trade_profile.firsts_sent,
      favorite_trade_partner: tradePartners[0] || null,
      trade_partners: tradePartners
    },
    current_draft_capital: record.current_draft_capital,
    by_season: record.by_season,
    league_ranks: record.league_ranks
  };
}

function applyLeagueRanks(owners) {
  const metrics = [
    ["trade_activity", owner => owner.trade_profile.trades],
    ["waiver_claims", owner => owner.activity.waiver_claims_won],
    ["faab_spent", owner => owner.activity.faab_spent],
    ["future_firsts", owner => owner.current_draft_capital.first_round_picks],
    ["future_picks", owner => owner.current_draft_capital.total_future_picks]
  ];

  for (const [name, accessor] of metrics) {
    const values = [...new Set(owners.map(accessor))].sort((a, b) => b - a);
    for (const owner of owners) {
      owner.league_ranks[name] = values.indexOf(accessor(owner)) + 1;
    }
  }
}


async function rebuildLeagueIntelligence(githubToken, activeLeagueId) {
  const [
    gameHistoryDoc,
    playoffHistoryDoc,
    ownerTendenciesDoc,
    currentDoc,
    playerValuesDoc,
    powerRankingsDoc
  ] = await Promise.all([
    getGitHubJSON("game-history.json", githubToken),
    getGitHubJSON("playoff-history.json", githubToken),
    getGitHubJSON("owner-tendencies.json", githubToken),
    getGitHubJSON("current.json", githubToken),
    getGitHubJSON("player-values.json", githubToken).catch(() => null),
    getGitHubJSON("power-rankings.json", githubToken).catch(() => null)
  ]);

  if (!gameHistoryDoc || !Array.isArray(gameHistoryDoc.games)) {
    throw new Error("game-history.json must exist before league intelligence can be rebuilt.");
  }
  if (!ownerTendenciesDoc || !Array.isArray(ownerTendenciesDoc.owners)) {
    throw new Error("owner-tendencies.json must exist before league intelligence can be rebuilt.");
  }
  if (!currentDoc) {
    throw new Error("current.json must exist before league intelligence can be rebuilt.");
  }

  const payload = buildLeagueIntelligencePayload({
    generatedAt: new Date().toISOString(),
    activeLeagueId,
    gameHistoryDoc,
    playoffHistoryDoc,
    ownerTendenciesDoc,
    currentDoc,
    playerValuesDoc,
    powerRankingsDoc
  });
  const path = "league-intelligence.json";
  await upsertGitHubJSON(
    path,
    payload,
    "Update historical Sleeper league intelligence",
    githubToken
  );

  return {
    path,
    seasons: payload.coverage.seasons,
    completed_game_count: payload.coverage.completed_game_count,
    future_matchups_excluded: payload.coverage.excluded_future_or_incomplete_matchups,
    franchise_count: payload.franchise_history.length,
    rivalry_count: payload.rivalries.rivalry_count,
    owner_archetype_count: payload.owner_archetypes.length,
    latest_completed_week: payload.awards.latest_completed_week
      ? {
          season: payload.awards.latest_completed_week.season,
          week: payload.awards.latest_completed_week.week,
          phase: payload.awards.latest_completed_week.phase
        }
      : null
  };
}


async function rebuildPlayerIntelligence(
  githubToken,
  activeLeagueId,
  providedChain = null
) {
  const currentDoc = await getGitHubJSON("current.json", githubToken);
  if (!currentDoc) {
    throw new Error("current.json must exist before player intelligence can be rebuilt.");
  }

  let nflState = null;
  try { nflState = await getJSON(`${SLEEPER}/state/nfl`); } catch {}
  const displayWeek = Number(nflState?.display_week || nflState?.week || 1);
  const week = Math.min(
    NFL_REGULAR_SEASON_WEEKS,
    Math.max(1, Number.isFinite(displayWeek) ? displayWeek : 1)
  );
  const season = String(currentDoc.season || currentDoc.league?.season || "");
  const sharedProjectionFeeds = await fetchSharedProjectionFeeds(season);

  const playerValues = await rebuildPlayerValues(
    githubToken,
    activeLeagueId,
    currentDoc
  );
  const seasonProjections = await rebuildSeasonProjections(
    githubToken,
    activeLeagueId,
    currentDoc,
    sharedProjectionFeeds
  );
  const weeklyProjections = await rebuildWeeklyProjections(
    githubToken,
    activeLeagueId,
    week,
    currentDoc,
    sharedProjectionFeeds
  );
  const projectionSummary = await rebuildProjectionSummary(
    githubToken,
    activeLeagueId,
    currentDoc
  );
  const chain = providedChain || await discoverLeagueChain(activeLeagueId);
  const powerRankings = await rebuildPowerRankings(
    githubToken,
    activeLeagueId,
    chain
  );

  return {
    season,
    refreshed_week: week,
    player_values: playerValues,
    season_projections: seasonProjections,
    weekly_projections: weeklyProjections,
    projection_summary: projectionSummary,
    power_rankings: powerRankings
  };
}

async function rebuildPlayerValues(githubToken, activeLeagueId, providedCurrentDoc = null) {
  const currentDoc = providedCurrentDoc || await getGitHubJSON("current.json", githubToken);
  if (!currentDoc) {
    throw new Error("current.json must exist before player values can be rebuilt.");
  }

  const league = currentDoc.league || {};
  const settings = fantasyCalcLeagueSettings(league);
  const fantasyCalcUrl = new URL(FANTASY_CALC);
  fantasyCalcUrl.searchParams.set("isDynasty", "true");
  fantasyCalcUrl.searchParams.set("numQbs", String(settings.num_qbs));
  fantasyCalcUrl.searchParams.set("numTeams", String(settings.num_teams));
  fantasyCalcUrl.searchParams.set("ppr", String(settings.ppr));

  const [fantasyCalcRows, dynastyProcessCsv, dynastyDealerDoc] = await Promise.all([
    getBoundedJSON(
      fantasyCalcUrl.toString(),
      MAX_EXTERNAL_FEED_BYTES,
      "FantasyCalc dynasty values"
    ),
    getBoundedText(
      DYNASTY_PROCESS_VALUES,
      MAX_EXTERNAL_FEED_BYTES,
      "DynastyProcess player values"
    ),
    getBoundedJSON(
      DYNASTY_DEALER_VALUES,
      MAX_EXTERNAL_FEED_BYTES,
      "Dynasty Dealer player values"
    )
  ]);

  const dynastyDealerRows = Array.isArray(dynastyDealerDoc?.players)
    ? dynastyDealerDoc.players
    : [];
  if (dynastyDealerRows.length === 0) {
    throw new Error("Dynasty Dealer player values did not include any players.");
  }
  const dynastyDealerBySleeperId = new Map(
    dynastyDealerRows
      .filter(row => row?.sleeper_id != null)
      .map(row => [String(row.sleeper_id), row])
  );

  const dynastyProcessRows = parseCsvObjects(dynastyProcessCsv);
  const dynastyProcessByPlayer = new Map();
  for (const row of dynastyProcessRows) {
    const position = String(row.pos || "").toUpperCase();
    const name = String(row.player || "");
    if (!PROJECTION_POSITIONS.includes(position) || !name) continue;
    const key = externalPlayerKey(name, position);
    const existing = dynastyProcessByPlayer.get(key);
    if (!existing || numericOrNull(row.value_2qb) > numericOrNull(existing.value_2qb)) {
      dynastyProcessByPlayer.set(key, row);
    }
  }

  const currentPlayers = currentPlayerOwnership(currentDoc.teams || []);
  const recordsById = new Map();

  for (const row of Array.isArray(fantasyCalcRows) ? fantasyCalcRows : []) {
    const player = row?.player || {};
    const playerId = player.sleeperId == null ? null : String(player.sleeperId);
    const position = String(player.position || "").toUpperCase();
    if (!playerId || !PROJECTION_POSITIONS.includes(position)) continue;

    recordsById.set(playerId, {
      player_id: playerId,
      name: player.name || playerId,
      position,
      team: player.maybeTeam || null,
      age: numericOrNull(player.maybeAge),
      ownership: currentPlayers.get(playerId)?.ownership || null,
      fantasycalc: {
        value: numericOrNull(row.value),
        overall_rank: numericOrNull(row.overallRank),
        position_rank: numericOrNull(row.positionRank),
        trend_30_day: numericOrNull(row.trend30Day),
        trade_frequency: numericOrNull(row.maybeTradeFrequency),
        roster_percentage: numericOrNull(row.maybeRosterPercent)
      },
      dynastyprocess: null,
      dynastydealer: null
    });
  }

  for (const [playerId, current] of currentPlayers.entries()) {
    if (!PROJECTION_POSITIONS.includes(String(current.player.position || "").toUpperCase())) continue;
    if (!recordsById.has(playerId)) {
      recordsById.set(playerId, {
        player_id: playerId,
        name: current.player.name || playerId,
        position: String(current.player.position || "").toUpperCase(),
        team: current.player.team || null,
        age: numericOrNull(current.player.age),
        ownership: current.ownership,
        fantasycalc: null,
        dynastyprocess: null,
        dynastydealer: null
      });
    } else {
      recordsById.get(playerId).ownership = current.ownership;
    }
  }

  for (const record of recordsById.values()) {
    const dpRow = dynastyProcessByPlayer.get(externalPlayerKey(record.name, record.position));
    if (!dpRow) continue;
    record.dynastyprocess = {
      value_2qb: numericOrNull(dpRow.value_2qb),
      ecr_2qb: numericOrNull(dpRow.ecr_2qb),
      ecr_position: numericOrNull(dpRow.ecr_pos),
      scrape_date: dpRow.scrape_date || null,
      fantasypros_id: dpRow.fp_id || null
    };
    record.team = record.team || dpRow.team || null;
    record.age = record.age ?? numericOrNull(dpRow.age);
  }

  for (const record of recordsById.values()) {
    const dealerRow = dynastyDealerBySleeperId.get(record.player_id);
    if (!dealerRow) continue;
    record.dynastydealer = {
      current_value: numericOrNull(dealerRow.current_value),
      base_value: numericOrNull(dealerRow.base_value),
      community_votes: numericOrNull(dealerRow.votes),
      updated_at: dealerRow.updated_at || null
    };
    record.team = record.team || dealerRow.team || null;
    record.age = record.age ?? numericOrNull(dealerRow.age);
  }

  const records = [...recordsById.values()];
  const fantasyCalcMax = Math.max(
    0,
    ...records.map(record => Number(record.fantasycalc?.value || 0))
  );
  const dynastyProcessMax = Math.max(
    0,
    ...records.map(record => Number(record.dynastyprocess?.value_2qb || 0))
  );
  const dynastyDealerMax = Math.max(
    0,
    ...records.map(record => Number(record.dynastydealer?.current_value || 0))
  );

  for (const record of records) {
    const fantasyCalcValue = Number(record.fantasycalc?.value || 0);
    const dynastyProcessValue = Number(record.dynastyprocess?.value_2qb || 0);
    const dynastyDealerValue = Number(record.dynastydealer?.current_value || 0);
    const fantasyCalcScore = fantasyCalcValue > 0 && fantasyCalcMax > 0
      ? 100 * fantasyCalcValue / fantasyCalcMax
      : null;
    const dynastyProcessScore = dynastyProcessValue > 0 && dynastyProcessMax > 0
      ? 100 * dynastyProcessValue / dynastyProcessMax
      : null;
    const dynastyDealerScore = dynastyDealerValue > 0 && dynastyDealerMax > 0
      ? 100 * dynastyDealerValue / dynastyDealerMax
      : null;
    const availableScores = [fantasyCalcScore, dynastyProcessScore, dynastyDealerScore]
      .filter(Number.isFinite);
    const marketScores = [fantasyCalcScore, dynastyDealerScore].filter(Number.isFinite);
    const marketLensScore = marketScores.length
      ? marketScores.reduce((sum, value) => sum + value, 0) / marketScores.length
      : null;
    const independentLensScores = [marketLensScore, dynastyProcessScore].filter(Number.isFinite);
    const consensusScore = independentLensScores.length
      ? independentLensScores.reduce((sum, value) => sum + value, 0) / independentLensScores.length
      : 0;
    const disagreement = availableScores.length > 1
      ? Math.max(...availableScores) - Math.min(...availableScores)
      : null;

    record.source_scores = {
      fantasycalc_0_to_100: Number.isFinite(fantasyCalcScore) ? round2(fantasyCalcScore) : null,
      dynastyprocess_0_to_100: Number.isFinite(dynastyProcessScore) ? round2(dynastyProcessScore) : null,
      dynastydealer_0_to_100: Number.isFinite(dynastyDealerScore) ? round2(dynastyDealerScore) : null,
      trade_market_lens_0_to_100: Number.isFinite(marketLensScore) ? round2(marketLensScore) : null
    };
    record.consensus_value_score = round2(consensusScore);
    record.consensus_value = Math.round(consensusScore * 100);
    record.source_count = availableScores.length;
    record.source_disagreement = Number.isFinite(disagreement) ? round2(disagreement) : null;
    record.confidence_score = availableScores.length === 3
      ? round2(Math.max(55, 100 - disagreement))
      : (availableScores.length === 2
        ? round2(Math.max(45, 85 - disagreement))
        : (availableScores.length === 1 ? 40 : 0));
    record.league_status = record.ownership ? "rostered" : "free_agent";
  }

  records.sort((a, b) =>
    b.consensus_value_score - a.consensus_value_score ||
    Number(a.fantasycalc?.overall_rank || 99999) - Number(b.fantasycalc?.overall_rank || 99999) ||
    String(a.name).localeCompare(String(b.name))
  );

  const positionRanks = new Map();
  records.forEach((record, index) => {
    record.consensus_rank = record.consensus_value_score > 0 ? index + 1 : null;
    const positionCount = (positionRanks.get(record.position) || 0) + 1;
    positionRanks.set(record.position, positionCount);
    record.consensus_position_rank = record.consensus_value_score > 0 ? positionCount : null;
  });

  const lineupSize = (league.roster_positions || []).filter(isProjectionSlot).length;
  const teamRows = (currentDoc.teams || []).map(team => {
    const rosterValues = (team.players || [])
      .map(player => recordsById.get(String(player.player_id)))
      .filter(Boolean)
      .sort((a, b) => b.consensus_value - a.consensus_value);
    const lineupAdjustedValue = rosterValues.reduce((sum, record, index) => {
      const weight = index < lineupSize ? 1 : (index < lineupSize + 6 ? 0.35 : 0.10);
      return sum + record.consensus_value * weight;
    }, 0);
    const sourcedPlayers = rosterValues.filter(record => record.source_count > 0).length;

    return {
      roster_id: Number(team.roster_id),
      owner_id: team.owner_id || null,
      team_name: team.team_name || null,
      roster_player_count: (team.players || []).length,
      valued_player_count: sourcedPlayers,
      valuation_coverage: (team.players || []).length
        ? round3(sourcedPlayers / (team.players || []).length)
        : 0,
      full_roster_consensus_value: Math.round(
        rosterValues.reduce((sum, record) => sum + record.consensus_value, 0)
      ),
      lineup_adjusted_value_raw: round2(lineupAdjustedValue),
      top_assets: rosterValues.slice(0, 10).map(record => ({
        player_id: record.player_id,
        name: record.name,
        position: record.position,
        consensus_value: record.consensus_value,
        consensus_rank: record.consensus_rank
      }))
    };
  });

  const teamValuePercentiles = percentileScoreMap(
    teamRows,
    row => row.lineup_adjusted_value_raw,
    row => row.roster_id
  );
  for (const team of teamRows) {
    team.roster_value_score = round2(teamValuePercentiles.get(team.roster_id) || 0);
  }
  teamRows.sort((a, b) =>
    b.roster_value_score - a.roster_value_score ||
    b.lineup_adjusted_value_raw - a.lineup_adjusted_value_raw ||
    a.roster_id - b.roster_id
  );
  teamRows.forEach((team, index) => { team.roster_value_rank = index + 1; });

  const rosteredRecords = records.filter(record => record.ownership);
  const payload = {
    generated_at: new Date().toISOString(),
    league: {
      league_id: String(league.league_id || activeLeagueId),
      name: league.name || null,
      season: String(currentDoc.season || league.season || ""),
      format: settings
    },
    ranking_type: "normalized_multi_feed_dynasty_consensus",
    methodology: {
      sources_are_normalized_separately: true,
      consensus: "FantasyCalc and Dynasty Dealer are averaged into one trade-market lens. That market lens and the DynastyProcess/FantasyPros expert lens each receive 50% when available. Missing sources do not count as zero.",
      team_value: "All dynasty assets count, but the top lineup-sized group receives full weight, the next six assets receive 35%, and remaining depth receives 10% so elite starters matter more than unusable depth.",
      confidence: "Higher when more sources cover a player and their normalized values agree. The disagreement field is the range between the highest and lowest normalized source score.",
      source_independence: "FantasyCalc and Dynasty Dealer are distinct transaction-derived models but represent the same broad market signal, so they are clustered instead of double-weighted. DynastyProcess is based on FantasyPros expert consensus."
    },
    sources: {
      fantasycalc: {
        url: fantasyCalcUrl.toString(),
        basis: "Values generated from completed fantasy trades.",
        fetched_for: settings
      },
      dynastyprocess: {
        url: DYNASTY_PROCESS_VALUES,
        basis: "Open weekly FantasyPros ECR-derived dynasty values.",
        latest_scrape_date: records
          .map(record => record.dynastyprocess?.scrape_date)
          .filter(Boolean)
          .sort()
          .at(-1) || null
      },
      dynastydealer: {
        url: DYNASTY_DEALER_VALUES,
        attribution: "Values by Dynasty Dealer — https://www.dynastydealer.com/",
        basis: "Values generated from real Sleeper dynasty trades with a small community adjustment.",
        endpoint_timestamp: dynastyDealerDoc?.timestamp || null,
        latest_player_update: records
          .map(record => record.dynastydealer?.updated_at)
          .filter(Boolean)
          .sort()
          .at(-1) || null
      }
    },
    data_quality: {
      player_count: records.length,
      players_with_all_three_sources: records.filter(record => record.source_count === 3).length,
      players_with_both_sources: records.filter(record => record.source_count === 2).length,
      players_with_one_source: records.filter(record => record.source_count === 1).length,
      rostered_player_count: rosteredRecords.length,
      rostered_players_with_any_value: rosteredRecords.filter(record => record.source_count > 0).length,
      rostered_players_with_all_three_values: rosteredRecords.filter(record => record.source_count === 3).length,
      rostered_players_with_both_values: rosteredRecords.filter(record => record.source_count >= 2).length
    },
    players: records,
    teams: teamRows
  };

  const path = "player-values.json";
  await upsertGitHubJSON(
    path,
    payload,
    "Add multi-feed dynasty player values",
    githubToken
  );

  return {
    path,
    player_count: records.length,
    team_count: teamRows.length,
    players_with_all_three_sources: payload.data_quality.players_with_all_three_sources,
    rostered_players_with_any_value: payload.data_quality.rostered_players_with_any_value,
    rostered_players_with_all_three_values: payload.data_quality.rostered_players_with_all_three_values,
    rostered_player_count: payload.data_quality.rostered_player_count
  };
}

function fantasyCalcLeagueSettings(league) {
  const rosterPositions = Array.isArray(league.roster_positions)
    ? league.roster_positions
    : [];
  const hasSecondQuarterback = rosterPositions.includes("SUPER_FLEX") ||
    rosterPositions.filter(position => position === "QB").length > 1;
  const receptionPoints = Number(league.scoring_settings?.rec ?? 1);
  const supportedPpr = [0, 0.5, 1].reduce((best, value) =>
    Math.abs(value - receptionPoints) < Math.abs(best - receptionPoints) ? value : best
  , 1);

  return {
    num_qbs: hasSecondQuarterback ? 2 : 1,
    num_teams: Number(league.total_rosters || league.settings?.num_teams || 12),
    ppr: supportedPpr,
    tight_end_premium: false
  };
}

function currentPlayerOwnership(teams) {
  const result = new Map();
  for (const team of teams) {
    const taxiIds = new Set((team.taxi || []).filter(Boolean).map(player => String(player.player_id)));
    const reserveIds = new Set((team.reserve || []).filter(Boolean).map(player => String(player.player_id)));

    for (const player of (team.players || []).filter(Boolean)) {
      const playerId = String(player.player_id);
      const rosterStatus = taxiIds.has(playerId)
        ? "taxi"
        : (reserveIds.has(playerId) ? "reserve" : "active_roster");
      result.set(playerId, {
        player,
        ownership: {
          roster_id: Number(team.roster_id),
          owner_id: team.owner_id || null,
          team_name: team.team_name || null,
          roster_status: rosterStatus
        }
      });
    }
  }
  return result;
}

function externalPlayerKey(name, position) {
  return `${normalizePlayerName(name)}|${String(position || "").toUpperCase()}`;
}

function normalizePlayerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "" || value === "NA") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCsvObjects(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1)
    .filter(values => values.some(value => value !== ""))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function rebuildSeasonProjections(
  githubToken,
  activeLeagueId,
  providedCurrentDoc = null,
  providedSharedFeeds = null
) {
  const currentDoc = providedCurrentDoc || await getGitHubJSON("current.json", githubToken);
  if (!currentDoc) {
    throw new Error("current.json must exist before season projections can be rebuilt.");
  }

  const league = currentDoc.league || {};
  const season = String(currentDoc.season || league.season || "");
  if (!season) throw new Error("The active season could not be determined.");

  const sharedFeeds = providedSharedFeeds || await fetchSharedProjectionFeeds(season);
  const sleeperFeed = await settleProjectionFeed(
    "sleeper",
    () => fetchSleeperProjectionRows(season, null)
  );
  const ownership = currentPlayerOwnership(currentDoc.teams || []);
  const players = normalizeConsensusProjectionRows({
    sleeperRows: sleeperFeed.ok ? sleeperFeed.data : [],
    espnDoc: sharedFeeds.espn?.ok ? sharedFeeds.espn.data : null,
    statheadDoc: sharedFeeds.stathead?.ok ? sharedFeeds.stathead.data : null,
    season,
    week: null,
    scoringSettings: league.scoring_settings || {},
    ownership
  });
  if (players.length === 0) {
    throw new Error("No full-season player projections were available from any source.");
  }
  const projectionById = new Map(players.map(player => [String(player.player_id), player]));
  const teams = (currentDoc.teams || []).map(team =>
    buildTeamProjection(team, projectionById, league.roster_positions || [])
  );
  teams.sort((a, b) =>
    b.projected_points - a.projected_points || a.roster_id - b.roster_id
  );
  teams.forEach((team, index) => { team.projection_rank = index + 1; });

  const generatedAt = new Date().toISOString();
  const path = `projections/${season}/season.json`;
  const payload = {
    generated_at: generatedAt,
    season,
    projection_scope: "full_regular_season",
    league: projectionLeagueSummary(league, activeLeagueId, season),
    source: {
      type: "multi_source_consensus",
      names: Object.values(PROJECTION_SOURCE_NAMES)
    },
    sources: projectionSourceDescriptions(sleeperFeed, sharedFeeds),
    methodology: {
      player_points: "Equal-weight mean of each available Sleeper/RotoWire, ESPN, and StatHead projection. Sleeper and ESPN counting stats are scored with this league's settings; StatHead PPR is adjusted with the player's Sleeper league-to-PPR factor when available.",
      missing_sources: "A missing source is ignored, never treated as zero. Source count, spread, and confidence are retained for every player.",
      team_points: "Selects the highest-projected legal lineup from each current active roster. Taxi and reserve players are excluded from lineup eligibility.",
      caution: "The team season total uses one lineup optimized on full-season player totals. The week-by-week aggregate becomes the more precise team forecast as all weekly files are populated."
    },
    data_quality: projectionDataQuality(players),
    player_count: players.length,
    team_count: teams.length,
    players,
    teams
  };

  await upsertGitHubJSON(
    path,
    payload,
    `Update ${season} full-season player projections`,
    githubToken
  );

  return {
    path,
    season,
    player_count: players.length,
    team_count: teams.length,
    source_last_modified: latestProjectionTimestamp(players),
    players_with_three_sources: players.filter(player => player.projection_source_count === 3).length
  };
}

async function rebuildWeeklyProjections(
  githubToken,
  activeLeagueId,
  week,
  providedCurrentDoc = null,
  providedSharedFeeds = null
) {
  const currentDoc = providedCurrentDoc || await getGitHubJSON("current.json", githubToken);
  if (!currentDoc) {
    throw new Error("current.json must exist before weekly projections can be rebuilt.");
  }

  const league = currentDoc.league || {};
  const season = String(currentDoc.season || league.season || "");
  if (!season) throw new Error("The active season could not be determined.");

  const sharedFeeds = providedSharedFeeds || await fetchSharedProjectionFeeds(season);
  const [sleeperFeed, matchupRows] = await Promise.all([
    settleProjectionFeed("sleeper", () => fetchSleeperProjectionRows(season, week)),
    getJSON(`${SLEEPER}/league/${activeLeagueId}/matchups/${week}`)
  ]);
  const ownership = currentPlayerOwnership(currentDoc.teams || []);
  const players = normalizeConsensusProjectionRows({
    sleeperRows: sleeperFeed.ok ? sleeperFeed.data : [],
    espnDoc: sharedFeeds.espn?.ok ? sharedFeeds.espn.data : null,
    statheadDoc: sharedFeeds.stathead?.ok ? sharedFeeds.stathead.data : null,
    season,
    week,
    scoringSettings: league.scoring_settings || {},
    ownership
  });
  if (players.length === 0) {
    throw new Error(`No week ${week} player projections were available from any source.`);
  }
  const projectionById = new Map(players.map(player => [String(player.player_id), player]));
  const teams = (currentDoc.teams || []).map(team =>
    buildTeamProjection(team, projectionById, league.roster_positions || [])
  );
  const matchups = buildProjectedMatchups(
    matchupRows,
    teams,
    week,
    Number(league.settings?.playoff_week_start || 15)
  );

  teams.sort((a, b) =>
    b.projected_points - a.projected_points || a.roster_id - b.roster_id
  );
  teams.forEach((team, index) => { team.weekly_projection_rank = index + 1; });

  const generatedAt = new Date().toISOString();
  const weekLabel = String(week).padStart(2, "0");
  const path = `projections/${season}/weeks/week-${weekLabel}.json`;
  const payload = {
    generated_at: generatedAt,
    season,
    week,
    phase: week >= Number(league.settings?.playoff_week_start || 15)
      ? "postseason"
      : "regular",
    league: projectionLeagueSummary(league, activeLeagueId, season),
    source: {
      type: "multi_source_consensus",
      names: Object.values(PROJECTION_SOURCE_NAMES)
    },
    sources: projectionSourceDescriptions(sleeperFeed, sharedFeeds),
    methodology: {
      player_points: "Equal-weight mean of each available Sleeper/RotoWire, ESPN, and StatHead projection, adjusted to this league's scoring where the feed exposes the required stats.",
      missing_sources: "A missing source is ignored, never treated as zero. Source count, spread, and confidence are retained for every player.",
      team_points: "Highest-projected legal lineup from each current active roster; taxi and reserve players are excluded.",
      matchup_result: "The projected favorite is the team with the higher optimized lineup score. Win probability is intentionally withheld until historical projection errors have been backtested."
    },
    data_quality: projectionDataQuality(players),
    player_count: players.length,
    team_count: teams.length,
    matchup_count: matchups.length,
    players,
    teams,
    matchups
  };

  await upsertGitHubJSON(
    path,
    payload,
    `Update ${season} week ${week} player and matchup projections`,
    githubToken
  );

  return {
    path,
    season,
    week,
    player_count: players.length,
    team_count: teams.length,
    matchup_count: matchups.length,
    source_last_modified: latestProjectionTimestamp(players),
    players_with_three_sources: players.filter(player => player.projection_source_count === 3).length
  };
}

async function rebuildProjectionSummary(
  githubToken,
  activeLeagueId,
  providedCurrentDoc = null
) {
  const currentDoc = providedCurrentDoc || await getGitHubJSON("current.json", githubToken);
  if (!currentDoc) {
    throw new Error("current.json must exist before the projection summary can be rebuilt.");
  }

  const league = currentDoc.league || {};
  const season = String(currentDoc.season || league.season || "");
  const seasonDoc = await getGitHubJSON(`projections/${season}/season.json`, githubToken);
  const weekDocs = await Promise.all(
    Array.from({ length: NFL_REGULAR_SEASON_WEEKS }, (_, index) =>
      getGitHubJSON(
        `projections/${season}/weeks/week-${String(index + 1).padStart(2, "0")}.json`,
        githubToken
      ).catch(() => null)
    )
  );
  const availableWeekDocs = weekDocs.filter(Boolean).sort((a, b) => a.week - b.week);
  const availableWeeks = availableWeekDocs.map(doc => Number(doc.week));
  const playerMap = new Map();

  for (const player of (seasonDoc?.players || [])) {
    playerMap.set(String(player.player_id), {
      player_id: String(player.player_id),
      name: player.name || String(player.player_id),
      position: player.position || null,
      team: player.team || null,
      ownership: player.ownership || null,
      full_season_projected_points: round2(player.projected_points),
      full_season_provider_ppr_points: round2(player.provider_points?.ppr),
      full_season_projection_sources: player.projection_sources || [],
      full_season_projection_source_count: Number(player.projection_source_count || 0),
      full_season_source_spread_points: numericOrNull(player.projection_source_spread_points),
      full_season_confidence_score: numericOrNull(player.confidence_score),
      projected_games: numericOrNull(player.projected_stats?.gp),
      projected_points_per_game: numericOrNull(player.projected_stats?.gp) > 0
        ? round2(player.projected_points / Number(player.projected_stats.gp))
        : null,
      weekly: []
    });
  }

  for (const weekDoc of availableWeekDocs) {
    for (const player of (weekDoc.players || [])) {
      const playerId = String(player.player_id);
      if (!playerMap.has(playerId)) {
        playerMap.set(playerId, {
          player_id: playerId,
          name: player.name || playerId,
          position: player.position || null,
          team: player.team || null,
          ownership: player.ownership || null,
          full_season_projected_points: null,
          full_season_provider_ppr_points: null,
          full_season_projection_sources: [],
          full_season_projection_source_count: 0,
          full_season_source_spread_points: null,
          full_season_confidence_score: null,
          projected_games: null,
          projected_points_per_game: null,
          weekly: []
        });
      }
      const summary = playerMap.get(playerId);
      summary.ownership = summary.ownership || player.ownership || null;
      summary.weekly.push({
        week: Number(weekDoc.week),
        opponent: player.opponent || null,
        game_date: player.game_date || null,
        projected_points: round2(player.projected_points),
        provider_ppr_points: round2(player.provider_points?.ppr),
        projection_sources: player.projection_sources || [],
        projection_source_count: Number(player.projection_source_count || 0),
        source_spread_points: numericOrNull(player.projection_source_spread_points),
        confidence_score: numericOrNull(player.confidence_score)
      });
    }
  }

  const players = [...playerMap.values()].map(player => {
    player.weekly.sort((a, b) => a.week - b.week);
    player.weekly_projected_points_sum = round2(
      player.weekly.reduce((sum, row) => sum + Number(row.projected_points || 0), 0)
    );
    player.week_projection_count = player.weekly.length;
    return player;
  }).sort((a, b) =>
    Number(b.full_season_projected_points || b.weekly_projected_points_sum || 0) -
      Number(a.full_season_projected_points || a.weekly_projected_points_sum || 0) ||
    String(a.name).localeCompare(String(b.name))
  );
  players.forEach((player, index) => { player.season_projection_rank = index + 1; });

  const seasonTeamByRoster = new Map(
    (seasonDoc?.teams || []).map(team => [Number(team.roster_id), team])
  );
  const teamMap = new Map((currentDoc.teams || []).map(team => [
    Number(team.roster_id),
    {
      roster_id: Number(team.roster_id),
      owner_id: team.owner_id || null,
      team_name: team.team_name || null,
      consensus_full_season_lineup_projection: round2(
        seasonTeamByRoster.get(Number(team.roster_id))?.projected_points || 0
      ),
      provider_full_season_lineup_projection: round2(
        seasonTeamByRoster.get(Number(team.roster_id))?.projected_points || 0
      ),
      weekly: [],
      projected_regular_season_record: { wins: 0, losses: 0, ties: 0 },
      schedule: []
    }
  ]));

  for (const weekDoc of availableWeekDocs) {
    for (const team of (weekDoc.teams || [])) {
      const summary = teamMap.get(Number(team.roster_id));
      if (!summary) continue;
      summary.weekly.push({
        week: Number(weekDoc.week),
        projected_points: round2(team.projected_points),
        lineup_projection_coverage: round3(team.lineup_projection_coverage)
      });
    }

    for (const matchup of (weekDoc.matchups || [])) {
      for (const side of [matchup.team_1, matchup.team_2]) {
        const summary = teamMap.get(Number(side?.roster_id));
        if (!summary) continue;
        const opponent = Number(side.roster_id) === Number(matchup.team_1?.roster_id)
          ? matchup.team_2
          : matchup.team_1;
        summary.schedule.push({
          week: Number(weekDoc.week),
          opponent_roster_id: opponent?.roster_id ?? null,
          opponent_team: opponent?.team_name || null,
          projected_points: round2(side.projected_points),
          opponent_projected_points: round2(opponent?.projected_points),
          projected_result: matchup.projected_winner_roster_id == null
            ? "tie"
            : (Number(matchup.projected_winner_roster_id) === Number(side.roster_id) ? "win" : "loss")
        });

        if (Number(weekDoc.week) < Number(league.settings?.playoff_week_start || 15)) {
          if (matchup.projected_winner_roster_id == null) {
            summary.projected_regular_season_record.ties += 1;
          } else if (Number(matchup.projected_winner_roster_id) === Number(side.roster_id)) {
            summary.projected_regular_season_record.wins += 1;
          } else {
            summary.projected_regular_season_record.losses += 1;
          }
        }
      }
    }
  }

  const teams = [...teamMap.values()].map(team => {
    team.weekly.sort((a, b) => a.week - b.week);
    team.schedule.sort((a, b) => a.week - b.week);
    team.weekly_projected_points_sum = round2(
      team.weekly.reduce((sum, row) => sum + Number(row.projected_points || 0), 0)
    );
    team.regular_season_projected_points_sum = round2(
      team.weekly
        .filter(row => row.week < Number(league.settings?.playoff_week_start || 15))
        .reduce((sum, row) => sum + Number(row.projected_points || 0), 0)
    );
    team.week_projection_count = team.weekly.length;
    team.average_weekly_projected_points = team.weekly.length
      ? round2(team.weekly_projected_points_sum / team.weekly.length)
      : 0;
    return team;
  }).sort((a, b) =>
    b.consensus_full_season_lineup_projection - a.consensus_full_season_lineup_projection ||
    b.average_weekly_projected_points - a.average_weekly_projected_points ||
    a.roster_id - b.roster_id
  );
  teams.forEach((team, index) => { team.season_projection_rank = index + 1; });

  const generatedAt = new Date().toISOString();
  const missingWeeks = Array.from(
    { length: NFL_REGULAR_SEASON_WEEKS },
    (_, index) => index + 1
  ).filter(week => !availableWeeks.includes(week));
  const payload = {
    generated_at: generatedAt,
    season,
    league: projectionLeagueSummary(league, activeLeagueId, season),
    source: {
      type: "multi_source_consensus",
      names: Object.values(PROJECTION_SOURCE_NAMES)
    },
    sources: seasonDoc?.sources || availableWeekDocs.at(-1)?.sources || {},
    coverage: {
      full_season_projection_available: Boolean(seasonDoc),
      weekly_files_available: availableWeeks.length,
      available_weeks: availableWeeks,
      missing_weeks: missingWeeks,
      weekly_bootstrap_complete: missingWeeks.length === 0
    },
    methodology: {
      player_season_projection: "Equal-weight available-source consensus across Sleeper/RotoWire, ESPN, and StatHead.",
      player_weekly_projection: "Individual weekly consensus projections retain source coverage, disagreement, and confidence so changes over time can be audited.",
      team_season_projection: "Consensus full-season lineup projection is available immediately. The weekly aggregate becomes authoritative after all 18 weekly files are populated.",
      projected_record: "Compares optimized weekly lineup scores for each scheduled matchup; it is a deterministic projected record, not a probability simulation."
    },
    player_count: players.length,
    team_count: teams.length,
    players,
    teams
  };

  const path = "projection-summary.json";
  await upsertGitHubJSON(
    path,
    payload,
    `Update ${season} player and matchup projection summary`,
    githubToken
  );

  return {
    path,
    season,
    player_count: players.length,
    team_count: teams.length,
    available_weeks: availableWeeks,
    missing_weeks: missingWeeks,
    weekly_bootstrap_complete: missingWeeks.length === 0
  };
}

async function fetchSharedProjectionFeeds(season) {
  if (!/^\d{4}$/.test(String(season))) {
    throw new Error("Projection season must be a four-digit year.");
  }

  const [espn, stathead] = await Promise.all([
    settleProjectionFeed("espn", () => fetchEspnProjectionDoc(season)),
    settleProjectionFeed("stathead", () => fetchStatheadProjectionDoc(season))
  ]);
  return { espn, stathead };
}

async function settleProjectionFeed(source, loader) {
  try {
    return {
      source,
      ok: true,
      fetched_at: new Date().toISOString(),
      data: await loader()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "projection_feed_unavailable", source, error: message }));
    return {
      source,
      ok: false,
      fetched_at: new Date().toISOString(),
      error: message,
      data: null
    };
  }
}

async function fetchEspnProjectionDoc(season) {
  const url = `${ESPN_PROJECTIONS}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = JSON.stringify({
    players: {
      limit: 500,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterStatsForSourceIds: { value: [1] }
    }
  });
  const doc = await getBoundedJSON(
    url,
    MAX_EXTERNAL_FEED_BYTES,
    `ESPN ${season} projections`,
    { "X-Fantasy-Filter": filter }
  );
  if (!Array.isArray(doc?.players)) {
    throw new Error("ESPN projection response did not include a player pool.");
  }
  return doc;
}

async function fetchStatheadProjectionDoc(season) {
  const url = `${STATHEAD_PROJECTIONS}/weekly-projections-${season}.json`;
  const doc = await getBoundedJSON(
    url,
    MAX_EXTERNAL_FEED_BYTES,
    `StatHead ${season} projections`
  );
  if (!Array.isArray(doc?.players) || Number(doc?.season) !== Number(season)) {
    throw new Error("StatHead projection response did not match the requested season.");
  }
  return doc;
}

async function fetchSleeperProjectionRows(season, week = null) {
  const suffix = week == null ? String(season) : `${season}/${week}`;
  const url = new URL(`${SLEEPER_PROJECTIONS}/${suffix}`);
  url.searchParams.set("season_type", "regular");
  url.searchParams.set("order_by", "pts_ppr");
  for (const position of PROJECTION_POSITIONS) {
    url.searchParams.append("position[]", position);
  }

  const rows = await getBoundedJSON(
    url.toString(),
    MAX_EXTERNAL_FEED_BYTES,
    `Sleeper ${season}${week == null ? " season" : ` week ${week}`} projections`
  );
  if (!Array.isArray(rows)) {
    throw new Error("Sleeper projection response was not an array.");
  }
  return rows;
}

function normalizeProjectionRows(rows, scoringSettings, ownership) {
  const records = [];
  const seen = new Set();

  for (const row of rows) {
    const playerId = row?.player_id == null ? null : String(row.player_id);
    if (!playerId || seen.has(playerId)) continue;
    const stats = row.stats && typeof row.stats === "object" ? row.stats : {};
    const customPoints = calculateProjectedPoints(stats, scoringSettings);
    const providerPpr = Number(stats.pts_ppr || 0);
    if (!(customPoints > 0 || providerPpr > 0)) continue;
    seen.add(playerId);

    const player = row.player || {};
    const name = [player.first_name, player.last_name].filter(Boolean).join(" ") || playerId;
    records.push({
      player_id: playerId,
      name,
      position: player.position || null,
      fantasy_positions: Array.isArray(player.fantasy_positions)
        ? player.fantasy_positions
        : [player.position].filter(Boolean),
      team: row.team || player.team || null,
      opponent: row.opponent || null,
      game_date: row.date || null,
      projected_points: round2(customPoints),
      provider_points: {
        ppr: round2(stats.pts_ppr),
        half_ppr: round2(stats.pts_half_ppr),
        standard: round2(stats.pts_std)
      },
      projected_stats: projectionStatSubset(stats, scoringSettings),
      source_company: row.company || null,
      source_last_modified: timestampToIso(row.last_modified || row.updated_at),
      ownership: ownership.get(playerId)?.ownership || null,
      league_status: ownership.has(playerId) ? "rostered" : "free_agent"
    });
  }

  records.sort((a, b) =>
    b.projected_points - a.projected_points || String(a.name).localeCompare(String(b.name))
  );
  records.forEach((record, index) => { record.projection_rank = index + 1; });
  return records;
}

function normalizeConsensusProjectionRows({
  sleeperRows,
  espnDoc,
  statheadDoc,
  season,
  week,
  scoringSettings,
  ownership
}) {
  const sleeperRecords = normalizeProjectionRows(
    Array.isArray(sleeperRows) ? sleeperRows : [],
    scoringSettings,
    ownership
  );
  const sleeperById = new Map(
    sleeperRecords.map(record => [String(record.player_id), record])
  );
  const identities = new Map(sleeperById);

  for (const [playerId, current] of ownership.entries()) {
    const player = current?.player;
    const position = String(player?.position || "").toUpperCase();
    if (!player || !PROJECTION_POSITIONS.includes(position) || identities.has(playerId)) continue;
    identities.set(playerId, projectionIdentity({
      playerId,
      name: player.name || playerId,
      position,
      fantasyPositions: player.fantasy_positions,
      team: player.team,
      ownership: current.ownership
    }));
  }

  const statheadById = new Map();
  for (const row of (Array.isArray(statheadDoc?.players) ? statheadDoc.players : [])) {
    const playerId = row?.sleeper == null ? null : String(row.sleeper);
    const position = String(row?.pos || "").toUpperCase();
    if (!playerId || !PROJECTION_POSITIONS.includes(position)) continue;
    statheadById.set(playerId, row);
    if (!identities.has(playerId)) {
      identities.set(playerId, projectionIdentity({
        playerId,
        name: row.name || playerId,
        position,
        team: row.team,
        ownership: ownership.get(playerId)?.ownership || null
      }));
    }
  }

  const espnByPlayer = new Map();
  for (const wrapper of (Array.isArray(espnDoc?.players) ? espnDoc.players : [])) {
    const player = wrapper?.player || {};
    const position = ESPN_POSITION_BY_ID[Number(player.defaultPositionId)] || null;
    if (!position || !player.fullName) continue;
    const stats = Array.isArray(player.stats)
      ? player.stats
      : (Array.isArray(wrapper?.playerPoolEntry?.stats) ? wrapper.playerPoolEntry.stats : []);
    const projection = stats.find(stat =>
      Number(stat?.seasonId) === Number(season) &&
      Number(stat?.statSourceId ?? stat?.statTypeId) === 1 &&
      (week == null
        ? Number(stat?.statSplitTypeId) === 0 && Number(stat?.scoringPeriodId) === 0
        : Number(stat?.statSplitTypeId) === 1 && Number(stat?.scoringPeriodId) === Number(week))
    );
    if (!projection) continue;
    const projectedPoints = calculateEspnLeaguePoints(projection, scoringSettings);
    if (!(projectedPoints > 0)) continue;
    espnByPlayer.set(externalPlayerKey(player.fullName, position), {
      projected_points: projectedPoints,
      espn_player_id: player.id == null ? null : String(player.id)
    });
  }

  const records = [];
  for (const [playerId, identity] of identities.entries()) {
    const sleeper = sleeperById.get(playerId) || null;
    const espn = espnByPlayer.get(externalPlayerKey(identity.name, identity.position)) || null;
    const stathead = statheadById.get(playerId) || null;
    const sleeperPoints = positiveNumberOrNull(sleeper?.projected_points);
    const sleeperPpr = positiveNumberOrNull(sleeper?.provider_points?.ppr);
    const leagueAdjustment = sleeperPoints && sleeperPpr
      ? clamp(sleeperPoints / sleeperPpr, 0.75, 1.25)
      : 1;
    const statheadPpr = statheadProjectionPoints(stathead, week);
    const sourceRows = [
      { id: "sleeper", points: sleeperPoints },
      { id: "espn", points: positiveNumberOrNull(espn?.projected_points) },
      {
        id: "stathead",
        points: statheadPpr == null ? null : statheadPpr * leagueAdjustment
      }
    ].filter(source => Number.isFinite(source.points) && source.points > 0);

    if (sourceRows.length === 0) continue;
    const consensus = sourceRows.reduce((sum, source) => sum + source.points, 0) / sourceRows.length;
    const sourceMinimum = Math.min(...sourceRows.map(source => source.points));
    const sourceMaximum = Math.max(...sourceRows.map(source => source.points));
    const spread = sourceRows.length > 1 ? sourceMaximum - sourceMinimum : null;
    const spreadPercent = Number.isFinite(spread) && consensus > 0
      ? 100 * spread / consensus
      : null;
    const confidence = projectionConfidence(sourceRows.length, spreadPercent);

    records.push({
      ...identity,
      opponent: sleeper?.opponent || null,
      game_date: sleeper?.game_date || null,
      projected_points: round2(consensus),
      provider_points: sleeper?.provider_points || {
        ppr: null,
        half_ppr: null,
        standard: null
      },
      projected_stats: sleeper?.projected_stats || {},
      projection_sources: sourceRows.map(source => source.id),
      projection_source_names: sourceRows.map(source => PROJECTION_SOURCE_NAMES[source.id]),
      projection_source_count: sourceRows.length,
      projection_source_spread_points: Number.isFinite(spread) ? round2(spread) : null,
      projection_source_spread_percent: Number.isFinite(spreadPercent) ? round2(spreadPercent) : null,
      confidence_score: confidence,
      ensemble_method: "equal_weight_mean_of_available_sources",
      source_company: "multi-source ensemble",
      source_last_modified: sleeper?.source_last_modified || null,
      league_status: identity.ownership ? "rostered" : "free_agent"
    });
  }

  records.sort((a, b) =>
    b.projected_points - a.projected_points || String(a.name).localeCompare(String(b.name))
  );
  records.forEach((record, index) => { record.projection_rank = index + 1; });
  return records;
}

function projectionIdentity({
  playerId,
  name,
  position,
  fantasyPositions = null,
  team = null,
  ownership = null
}) {
  return {
    player_id: String(playerId),
    name: name || String(playerId),
    position: position || null,
    fantasy_positions: Array.isArray(fantasyPositions) && fantasyPositions.length
      ? fantasyPositions
      : [position].filter(Boolean),
    team: team || null,
    ownership: ownership || null
  };
}

function statheadProjectionPoints(row, week) {
  if (!row) return null;
  if (week == null) {
    const ppg = positiveNumberOrNull(row.ppg);
    const games = positiveNumberOrNull(row.gp);
    return ppg && games ? ppg * games : positiveNumberOrNull(row.rosPts);
  }
  if (!Array.isArray(row.wk)) return null;
  return positiveNumberOrNull(row.wk[Number(week) - 1]);
}

function calculateEspnLeaguePoints(projection, scoringSettings) {
  const stats = projection?.stats && typeof projection.stats === "object"
    ? projection.stats
    : {};
  const mappedStats = {
    pass_yd: numericOrNull(stats["3"]),
    pass_td: numericOrNull(stats["4"]),
    pass_2pt: numericOrNull(stats["19"]),
    pass_int: numericOrNull(stats["20"]),
    rush_yd: numericOrNull(stats["24"]),
    rush_td: numericOrNull(stats["25"]),
    rush_2pt: numericOrNull(stats["26"]),
    rec_yd: numericOrNull(stats["42"]),
    rec_td: numericOrNull(stats["43"]),
    rec_2pt: numericOrNull(stats["44"]),
    rec: numericOrNull(stats["53"]),
    fum_rec_td: numericOrNull(stats["63"]),
    fum_lost: numericOrNull(stats["72"])
  };
  const leaguePoints = calculateProjectedPoints(mappedStats, scoringSettings);
  if (leaguePoints > 0) return leaguePoints;

  const fallback = Number(projection?.appliedTotal);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function projectionConfidence(sourceCount, spreadPercent) {
  if (sourceCount >= 3) {
    return round2(Math.max(50, 100 - Number(spreadPercent || 0)));
  }
  if (sourceCount === 2) {
    return round2(Math.max(40, 80 - Number(spreadPercent || 0)));
  }
  return sourceCount === 1 ? 35 : 0;
}

function positiveNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function projectionDataQuality(players) {
  const rostered = players.filter(player => player.ownership);
  return {
    player_count: players.length,
    players_with_three_sources: players.filter(player => player.projection_source_count === 3).length,
    players_with_two_sources: players.filter(player => player.projection_source_count === 2).length,
    players_with_one_source: players.filter(player => player.projection_source_count === 1).length,
    rostered_player_count_with_projection: rostered.length,
    rostered_players_with_three_sources: rostered.filter(player => player.projection_source_count === 3).length,
    rostered_players_with_two_or_more_sources: rostered.filter(player => player.projection_source_count >= 2).length
  };
}

function calculateProjectedPoints(stats, scoringSettings) {
  let points = 0;
  for (const [statName, multiplierValue] of Object.entries(scoringSettings || {})) {
    const multiplier = Number(multiplierValue);
    const projectedStat = Number(stats?.[statName]);
    if (!Number.isFinite(multiplier) || !Number.isFinite(projectedStat)) continue;
    points += multiplier * projectedStat;
  }
  return points;
}

function projectionStatSubset(stats, scoringSettings) {
  const usageKeys = new Set([
    "gp", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int",
    "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd",
    "rec_td", "fum", "fum_lost"
  ]);
  for (const key of Object.keys(scoringSettings || {})) usageKeys.add(key);

  const output = {};
  for (const key of [...usageKeys].sort()) {
    const value = Number(stats?.[key]);
    if (Number.isFinite(value) && value !== 0) output[key] = value;
  }
  return output;
}

function buildTeamProjection(team, projectionById, rosterPositions) {
  const result = optimizeProjectedLineup(team, projectionById, rosterPositions);
  return {
    roster_id: Number(team.roster_id),
    owner_id: team.owner_id || null,
    team_name: team.team_name || null,
    projected_points: round2(result.projected_points),
    lineup_projection_coverage: round3(result.lineup_projection_coverage),
    projected_starter_count: result.lineup.filter(slot => slot.player).length,
    projected_starters_with_points: result.lineup.filter(slot => slot.projected_points > 0).length,
    optimal_lineup: result.lineup,
    projected_bench: result.bench
  };
}

function optimizeProjectedLineup(team, projectionById, rosterPositions) {
  const slots = (rosterPositions || []).filter(isProjectionSlot);
  if (slots.length === 0 || slots.length > 20) {
    return { projected_points: 0, lineup_projection_coverage: 0, lineup: [], bench: [] };
  }

  const taxiIds = new Set((team.taxi || []).filter(Boolean).map(player => String(player.player_id)));
  const reserveIds = new Set((team.reserve || []).filter(Boolean).map(player => String(player.player_id)));
  const candidates = (team.players || [])
    .filter(Boolean)
    .filter(player => {
      const playerId = String(player.player_id);
      return !taxiIds.has(playerId) && !reserveIds.has(playerId);
    })
    .map(player => {
      const projection = projectionById.get(String(player.player_id));
      return {
        player_id: String(player.player_id),
        name: player.name || projection?.name || String(player.player_id),
        position: player.position || projection?.position || null,
        fantasy_positions: player.fantasy_positions?.length
          ? player.fantasy_positions
          : (projection?.fantasy_positions || [player.position].filter(Boolean)),
        team: player.team || projection?.team || null,
        opponent: projection?.opponent || null,
        projected_points: round2(projection?.projected_points || 0)
      };
    });

  const stateCount = 1 << slots.length;
  let states = Array(stateCount).fill(null);
  states[0] = { points: 0, lineup: Array(slots.length).fill(null) };

  for (const candidate of candidates) {
    const next = states.slice();
    for (let mask = 0; mask < stateCount; mask++) {
      const state = states[mask];
      if (!state) continue;

      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const bit = 1 << slotIndex;
        if ((mask & bit) !== 0 || !playerEligibleForSlot(candidate, slots[slotIndex])) continue;
        const nextMask = mask | bit;
        const nextPoints = state.points + candidate.projected_points;
        if (!next[nextMask] || nextPoints > next[nextMask].points) {
          const lineup = state.lineup.slice();
          lineup[slotIndex] = candidate;
          next[nextMask] = { points: nextPoints, lineup };
        }
      }
    }
    states = next;
  }

  const fullMask = stateCount - 1;
  let best = states[fullMask];
  if (!best) {
    best = states.filter(Boolean).sort((a, b) =>
      b.lineup.filter(Boolean).length - a.lineup.filter(Boolean).length ||
      b.points - a.points
    )[0] || { points: 0, lineup: Array(slots.length).fill(null) };
  }

  const selectedIds = new Set(best.lineup.filter(Boolean).map(player => player.player_id));
  const lineup = slots.map((slot, index) => ({
    slot,
    player: best.lineup[index] ? {
      player_id: best.lineup[index].player_id,
      name: best.lineup[index].name,
      position: best.lineup[index].position,
      team: best.lineup[index].team,
      opponent: best.lineup[index].opponent
    } : null,
    projected_points: round2(best.lineup[index]?.projected_points || 0)
  }));
  const bench = candidates
    .filter(player => !selectedIds.has(player.player_id))
    .sort((a, b) => b.projected_points - a.projected_points || String(a.name).localeCompare(String(b.name)))
    .map(player => ({
      player_id: player.player_id,
      name: player.name,
      position: player.position,
      team: player.team,
      opponent: player.opponent,
      projected_points: player.projected_points
    }));
  const coveredSlots = lineup.filter(slot => slot.projected_points > 0).length;

  return {
    projected_points: best.points,
    lineup_projection_coverage: slots.length ? coveredSlots / slots.length : 0,
    lineup,
    bench
  };
}

function isProjectionSlot(slot) {
  return ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX"].includes(slot);
}

function playerEligibleForSlot(player, slot) {
  const positions = new Set(
    (player.fantasy_positions?.length ? player.fantasy_positions : [player.position])
      .filter(Boolean)
      .map(position => String(position).toUpperCase())
  );
  if (slot === "FLEX") return ["RB", "WR", "TE"].some(position => positions.has(position));
  if (slot === "SUPER_FLEX") {
    return ["QB", "RB", "WR", "TE"].some(position => positions.has(position));
  }
  return positions.has(slot);
}

function buildProjectedMatchups(matchupRows, teams, week, playoffWeekStart) {
  const teamByRoster = new Map(teams.map(team => [Number(team.roster_id), team]));
  const groups = new Map();

  for (const row of Array.isArray(matchupRows) ? matchupRows : []) {
    if (row?.matchup_id === null || row?.matchup_id === undefined) continue;
    const key = String(row.matchup_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(row.roster_id));
  }

  const matchups = [];
  for (const [matchupId, rosterIds] of groups.entries()) {
    const uniqueRosterIds = [...new Set(rosterIds)].sort((a, b) => a - b);
    if (uniqueRosterIds.length < 2) continue;
    const teamOne = teamByRoster.get(uniqueRosterIds[0]);
    const teamTwo = teamByRoster.get(uniqueRosterIds[1]);
    if (!teamOne || !teamTwo) continue;
    const difference = round2(teamOne.projected_points - teamTwo.projected_points);
    const winnerRosterId = difference === 0
      ? null
      : (difference > 0 ? teamOne.roster_id : teamTwo.roster_id);

    matchups.push({
      matchup_id: Number.isFinite(Number(matchupId)) ? Number(matchupId) : matchupId,
      week,
      phase: week >= playoffWeekStart ? "postseason" : "regular",
      team_1: projectedTeamSide(teamOne),
      team_2: projectedTeamSide(teamTwo),
      projected_winner_roster_id: winnerRosterId,
      projected_winner_team: winnerRosterId == null
        ? null
        : (winnerRosterId === teamOne.roster_id ? teamOne.team_name : teamTwo.team_name),
      projected_margin: round2(Math.abs(difference)),
      projected_tie: difference === 0
    });
  }

  return matchups.sort((a, b) => Number(a.matchup_id) - Number(b.matchup_id));
}

function projectedTeamSide(team) {
  return {
    roster_id: team.roster_id,
    owner_id: team.owner_id,
    team_name: team.team_name,
    projected_points: team.projected_points,
    lineup_projection_coverage: team.lineup_projection_coverage
  };
}

function projectionLeagueSummary(league, activeLeagueId, season) {
  return {
    league_id: String(league.league_id || activeLeagueId),
    name: league.name || null,
    season,
    total_rosters: Number(league.total_rosters || league.settings?.num_teams || 0),
    scoring_settings: league.scoring_settings || {},
    roster_positions: league.roster_positions || [],
    playoff_week_start: Number(league.settings?.playoff_week_start || 15)
  };
}

function projectionSourceDescriptions(sleeperFeed, sharedFeeds) {
  const espnFeed = sharedFeeds?.espn || { ok: false, error: "not fetched" };
  const statheadFeed = sharedFeeds?.stathead || { ok: false, error: "not fetched" };
  return {
    ensemble: {
      method: "equal_weight_mean_of_available_sources",
      source_count_target: 3,
      missing_source_policy: "ignore_missing_not_zero",
      raw_espn_values_persisted: false
    },
    sleeper: {
      name: PROJECTION_SOURCE_NAMES.sleeper,
      status: sleeperFeed?.ok ? "available" : "unavailable",
      fetched_at: sleeperFeed?.fetched_at || null,
      error: sleeperFeed?.ok ? null : (sleeperFeed?.error || null),
      provider_company_reported_by_feed: "RotoWire",
      access_status: "Publicly reachable but not documented in Sleeper's official API reference.",
      scoring: "Projected counting stats scored with the league's Sleeper settings."
    },
    espn: {
      name: PROJECTION_SOURCE_NAMES.espn,
      status: espnFeed.ok ? "available" : "unavailable",
      fetched_at: espnFeed.fetched_at || null,
      error: espnFeed.ok ? null : (espnFeed.error || null),
      access_status: "Publicly reachable ESPN fantasy player pool endpoint; undocumented and isolated behind a fallback adapter.",
      scoring: "ESPN projected counting stats mapped to the league's Sleeper scoring settings.",
      retention: "Only the league-specific consensus and coverage metadata are persisted; raw ESPN projection rows are not republished."
    },
    stathead: {
      name: PROJECTION_SOURCE_NAMES.stathead,
      status: statheadFeed.ok ? "available" : "unavailable",
      fetched_at: statheadFeed.fetched_at || null,
      generated_at: statheadFeed.ok ? (statheadFeed.data?.generatedAt || null) : null,
      error: statheadFeed.ok ? null : (statheadFeed.error || null),
      model: "Open weekly model based on season PPG, opponent defense versus position, venue, and available market environment.",
      license: "StatHead model outputs are published for reuse; code is MIT licensed.",
      scoring: "PPR points adjusted by the player's Sleeper league-to-PPR factor when available."
    }
  };
}

function latestProjectionTimestamp(players) {
  return players
    .map(player => player.source_last_modified)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function timestampToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  try { return new Date(numeric).toISOString(); } catch { return null; }
}


async function rebuildPowerRankings(githubToken, activeLeagueId, providedChain = null) {
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const chain = [...chainNewestFirst].reverse();

  const [currentDoc, pickDoc, previousRankings, playerValueDoc, projectionDoc] = await Promise.all([
    getGitHubJSON("current.json", githubToken),
    getGitHubJSON("draft-pick-ownership.json", githubToken),
    getGitHubJSON("power-rankings.json", githubToken).catch(() => null),
    getGitHubJSON("player-values.json", githubToken).catch(() => null),
    getGitHubJSON("projection-summary.json", githubToken).catch(() => null)
  ]);

  const seasonTeamDocs = {};
  for (const leagueEntry of chain) {
    const season = String(leagueEntry.season);
    seasonTeamDocs[season] = await getGitHubJSON(`history/${season}/teams.json`, githubToken);
  }

  const currentSeason = String(currentDoc.season || currentDoc.league?.season || chainNewestFirst[0]?.season || "");
  const currentSeasonNumber = Number(currentSeason);
  const currentTeams = currentDoc.teams || [];
  const currentOwnerIds = new Set(currentTeams.map(team => String(team.owner_id)).filter(Boolean));

  const seasonStats = {};
  const playedSeasons = [];

  for (const leagueEntry of chainNewestFirst) {
    const season = String(leagueEntry.season);
    const teams = seasonTeamDocs[season]?.teams || [];
    const rows = teams
      .filter(team => currentOwnerIds.has(String(team.owner_id)))
      .map(team => {
        const record = team.record || {};
        const wins = Number(record.wins || 0);
        const losses = Number(record.losses || 0);
        const ties = Number(record.ties || 0);
        const games = wins + losses + ties;
        const pointsFor = Number(record.points_for || 0);
        return {
          owner_id: String(team.owner_id),
          roster_id: Number(team.roster_id),
          team_name: team.team_name || null,
          wins,
          losses,
          ties,
          games,
          win_pct: games ? (wins + 0.5 * ties) / games : 0,
          points_for: pointsFor,
          points_per_game: games ? pointsFor / games : 0
        };
      });

    const hasGames = rows.some(row => row.games > 0);
    if (hasGames) playedSeasons.push(season);

    const playedRows = rows.filter(row => row.games > 0);
    const winPctScores = percentileScoreMap(playedRows, row => row.win_pct, row => row.owner_id);
    const ppgScores = percentileScoreMap(playedRows, row => row.points_per_game, row => row.owner_id);

    seasonStats[season] = rows.map(row => ({
      ...row,
      performance_score: row.games > 0
        ? round2(0.6 * (winPctScores.get(row.owner_id) || 0) + 0.4 * (ppgScores.get(row.owner_id) || 0))
        : null
    }));
  }

  const performanceWeights = {};
  playedSeasons.slice(0, 3).forEach((season, index) => {
    performanceWeights[season] = [3, 2, 1][index];
  });

  const pickRowsByOwner = new Map(
    (pickDoc?.by_owner || []).map(row => [Number(row.roster_id), row])
  );
  const playerValueByRoster = new Map(
    (playerValueDoc?.teams || []).map(row => [Number(row.roster_id), row])
  );
  const projectionByRoster = new Map(
    (projectionDoc?.teams || []).map(row => [Number(row.roster_id), row])
  );

  const rankingRows = currentTeams.map(team => {
    const ownerId = String(team.owner_id);
    const perSeason = [];
    let weightedPerformanceSum = 0;
    let performanceWeightTotal = 0;

    for (const leagueEntry of chainNewestFirst) {
      const season = String(leagueEntry.season);
      const row = (seasonStats[season] || []).find(item => item.owner_id === ownerId);
      if (!row) continue;
      const recencyWeight = performanceWeights[season] || 0;
      if (recencyWeight && row.performance_score !== null) {
        weightedPerformanceSum += row.performance_score * recencyWeight;
        performanceWeightTotal += recencyWeight;
      }
      perSeason.push({
        season,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        games: row.games,
        win_pct: round3(row.win_pct),
        points_for: round2(row.points_for),
        points_per_game: round2(row.points_per_game),
        performance_score: row.performance_score,
        recency_weight: recencyWeight,
        included_in_competitive_score: Boolean(recencyWeight && row.performance_score !== null)
      });
    }

    const competitiveScore = performanceWeightTotal
      ? weightedPerformanceSum / performanceWeightTotal
      : 0;

    const pickSummary = pickRowsByOwner.get(Number(team.roster_id)) || {
      total_future_picks: 0,
      first_round_picks: 0,
      second_round_picks: 0,
      third_round_picks: 0,
      by_season: {}
    };

    const pickCapitalRaw = calculateDraftCapitalRawScore(pickSummary, currentSeasonNumber);
    const rosterProfile = summarizeRosterProfile(team);
    const record = team.record || {};
    const rosterValue = playerValueByRoster.get(Number(team.roster_id)) || null;
    const projection = projectionByRoster.get(Number(team.roster_id)) || null;

    return {
      owner_id: ownerId,
      roster_id: Number(team.roster_id),
      username: team.username || null,
      display_name: team.display_name || null,
      team_name: team.team_name || null,
      competitive_score_raw: competitiveScore,
      draft_capital_raw: pickCapitalRaw,
      roster_value_raw: numericOrNull(rosterValue?.lineup_adjusted_value_raw),
      projection_raw: numericOrNull(
        projection?.consensus_full_season_lineup_projection ||
        projection?.provider_full_season_lineup_projection ||
        projection?.average_weekly_projected_points
      ),
      recent_performance: perSeason,
      current_record: {
        wins: Number(record.wins || 0),
        losses: Number(record.losses || 0),
        ties: Number(record.ties || 0),
        points_for: round2(Number(record.points_for || 0)),
        points_against: round2(Number(record.points_against || 0))
      },
      draft_capital: {
        total_future_picks: pickSummary.total_future_picks || 0,
        first_round_picks: pickSummary.first_round_picks || 0,
        second_round_picks: pickSummary.second_round_picks || 0,
        third_round_picks: pickSummary.third_round_picks || 0,
        by_season: pickSummary.by_season || {}
      },
      roster_value: rosterValue ? {
        full_roster_consensus_value: rosterValue.full_roster_consensus_value || 0,
        lineup_adjusted_value: rosterValue.lineup_adjusted_value_raw || 0,
        valuation_coverage: rosterValue.valuation_coverage || 0,
        top_assets: rosterValue.top_assets || []
      } : null,
      projection: projection ? {
        consensus_full_season_lineup_projection: projection.consensus_full_season_lineup_projection ||
          projection.provider_full_season_lineup_projection || 0,
        provider_full_season_lineup_projection: projection.provider_full_season_lineup_projection || 0,
        average_weekly_projected_points: projection.average_weekly_projected_points || 0,
        available_week_count: projection.week_projection_count || 0,
        projected_regular_season_record: projection.projected_regular_season_record || null
      } : null,
      roster_profile: rosterProfile
    };
  });

  const competitivePercentiles = percentileScoreMap(
    rankingRows,
    row => row.competitive_score_raw,
    row => row.owner_id
  );
  const capitalPercentiles = percentileScoreMap(
    rankingRows,
    row => row.draft_capital_raw,
    row => row.owner_id
  );
  const rowsWithRosterValues = rankingRows.filter(row => Number.isFinite(row.roster_value_raw));
  const rowsWithProjections = rankingRows.filter(row => Number.isFinite(row.projection_raw));
  const rosterValuePercentiles = percentileScoreMap(
    rowsWithRosterValues,
    row => row.roster_value_raw,
    row => row.owner_id
  );
  const projectionPercentiles = percentileScoreMap(
    rowsWithProjections,
    row => row.projection_raw,
    row => row.owner_id
  );
  const externalPlayerValuesIncluded = rowsWithRosterValues.length === rankingRows.length && rankingRows.length > 0;
  const projectionsIncluded = rowsWithProjections.length === rankingRows.length && rankingRows.length > 0;

  for (const row of rankingRows) {
    row.recent_performance_score = round2(competitivePercentiles.get(row.owner_id) || 0);
    row.draft_capital_score = round2(capitalPercentiles.get(row.owner_id) || 0);
    row.roster_value_score = Number.isFinite(row.roster_value_raw)
      ? round2(rosterValuePercentiles.get(row.owner_id) || 0)
      : null;
    row.current_projection_score = Number.isFinite(row.projection_raw)
      ? round2(projectionPercentiles.get(row.owner_id) || 0)
      : null;
    row.competitive_score = row.current_projection_score === null
      ? row.recent_performance_score
      : round2(0.5 * row.recent_performance_score + 0.5 * row.current_projection_score);
    row.baseline_power_score = round2(
      0.7 * row.recent_performance_score + 0.3 * row.draft_capital_score
    );
    row.power_score = externalPlayerValuesIncluded
      ? round2(
          0.5 * row.roster_value_score +
          0.3 * row.competitive_score +
          0.2 * row.draft_capital_score
        )
      : row.baseline_power_score;
    delete row.competitive_score_raw;
    delete row.draft_capital_raw;
    delete row.roster_value_raw;
    delete row.projection_raw;
  }

  rankingRows.sort((a, b) =>
    b.power_score - a.power_score ||
    Number(b.roster_value_score || 0) - Number(a.roster_value_score || 0) ||
    b.competitive_score - a.competitive_score ||
    b.draft_capital_score - a.draft_capital_score ||
    String(a.team_name).localeCompare(String(b.team_name))
  );

  const previousRanks = new Map(
    (previousRankings?.rankings || []).map(row => [String(row.owner_id), Number(row.rank)])
  );

  rankingRows.forEach((row, index) => {
    row.rank = index + 1;
    const previousRank = previousRanks.get(row.owner_id);
    row.previous_rank = Number.isFinite(previousRank) ? previousRank : null;
    row.rank_change = Number.isFinite(previousRank) ? previousRank - row.rank : null;
  });

  const path = "power-rankings.json";
  const payload = {
    generated_at: new Date().toISOString(),
    league: {
      league_id: String(currentDoc.league?.league_id || activeLeagueId),
      name: currentDoc.league?.name || chainNewestFirst[0]?.name || null,
      season: currentSeason,
      status: currentDoc.league?.status || null
    },
    ranking_type: externalPlayerValuesIncluded
      ? "multi_feed_projection_enhanced"
      : "baseline_internal",
    external_player_values_included: externalPlayerValuesIncluded,
    projections_included: projectionsIncluded,
    methodology: {
      purpose: externalPlayerValuesIncluded
        ? "Franchise power ranking combining dynasty roster value, current competitive strength, and future draft capital."
        : "Objective baseline franchise power ranking used when external player values are unavailable.",
      composite_weights: externalPlayerValuesIncluded ? {
        multi_feed_roster_value_score: 0.50,
        competitive_score: 0.30,
        future_draft_capital_score: 0.20
      } : {
        recent_performance_score: 0.70,
        future_draft_capital_score: 0.30
      },
      roster_value_score: externalPlayerValuesIncluded
        ? "Lineup-adjusted three-feed consensus dynasty values from FantasyCalc, DynastyProcess, and Dynasty Dealer, converted to a league percentile."
        : "Unavailable; the ranking falls back to the internal baseline.",
      competitive_score: "Uses up to the three most recent seasons with games played. Within each season, 60% win-percentage percentile and 40% points-per-game percentile; most recent played seasons receive weights 3, 2, and 1.",
      projection_adjustment: projectionsIncluded
        ? "Competitive score is split evenly between recent-performance percentile and the current full-season optimized-lineup projection percentile."
        : "No projection adjustment was available; competitive score equals recent-performance score.",
      future_draft_capital_score: "Current future picks are valued by round (1st=3.0, 2nd=1.5, 3rd=0.75) and discounted by draft year (next draft=1.0, following=0.85, third=0.70), then converted to a league percentile.",
      roster_profile: "Age, experience, and positional counts are descriptive only and are not included in the baseline score.",
      limitation: projectionsIncluded
        ? "Projected records are deterministic comparisons, not calibrated win-probability simulations. Probability modeling will require stored projection-error history."
        : "Projection data has not yet been populated for every team.",
      movement: "rank_change compares with the previously generated power-rankings.json when one exists; positive means the team moved up."
    },
    performance_seasons_used: Object.entries(performanceWeights).map(([season, weight]) => ({ season, weight })),
    team_count: rankingRows.length,
    rankings: rankingRows
  };

  await upsertGitHubJSON(
    path,
    payload,
    "Update Sleeper power rankings",
    githubToken
  );

  return {
    path,
    ranking_type: payload.ranking_type,
    team_count: rankingRows.length,
    performance_seasons_used: payload.performance_seasons_used,
    external_player_values_included: externalPlayerValuesIncluded,
    projections_included: projectionsIncluded
  };
}

function percentileScoreMap(rows, valueAccessor, keyAccessor) {
  const numericRows = rows
    .map(row => ({ key: keyAccessor(row), value: Number(valueAccessor(row)) }))
    .filter(row => row.key !== null && row.key !== undefined && Number.isFinite(row.value));

  const uniqueValues = [...new Set(numericRows.map(row => row.value))].sort((a, b) => a - b);
  const result = new Map();

  for (const row of numericRows) {
    if (uniqueValues.length <= 1) {
      result.set(row.key, uniqueValues.length ? 50 : 0);
      continue;
    }
    const index = uniqueValues.indexOf(row.value);
    result.set(row.key, 100 * index / (uniqueValues.length - 1));
  }

  return result;
}

function calculateDraftCapitalRawScore(pickSummary, currentSeasonNumber) {
  let score = 0;
  const roundWeights = { 1: 3.0, 2: 1.5, 3: 0.75 };
  const yearDiscounts = { 1: 1.0, 2: 0.85, 3: 0.70 };

  for (const [season, seasonData] of Object.entries(pickSummary.by_season || {})) {
    const yearOffset = Number(season) - currentSeasonNumber;
    const yearDiscount = yearDiscounts[yearOffset] ?? Math.max(0.5, 1 - 0.15 * Math.max(0, yearOffset - 1));
    const picks = seasonData?.picks || [];
    for (const pick of picks) {
      const round = Number(pick.round);
      const roundWeight = roundWeights[round] ?? 0.35;
      score += roundWeight * yearDiscount;
    }
  }

  return round3(score);
}

function summarizeRosterProfile(team) {
  const players = (team.players || []).filter(Boolean);
  const fantasyPlayers = players.filter(player => player.position && player.position !== "DEF");
  const ages = fantasyPlayers.map(player => Number(player.age)).filter(Number.isFinite);
  const experience = fantasyPlayers.map(player => Number(player.years_exp)).filter(Number.isFinite);
  const positionCounts = {};

  for (const player of fantasyPlayers) {
    const position = player.position || "UNKNOWN";
    positionCounts[position] = (positionCounts[position] || 0) + 1;
  }

  return {
    total_players: players.length,
    fantasy_players: fantasyPlayers.length,
    average_age: ages.length ? round2(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
    average_years_experience: experience.length ? round2(experience.reduce((a, b) => a + b, 0) / experience.length) : null,
    players_with_2_or_fewer_years_experience: experience.filter(value => value <= 2).length,
    position_counts: positionCounts,
    starter_count: (team.starters || []).filter(Boolean).length,
    taxi_count: (team.taxi || []).filter(Boolean).length,
    reserve_count: (team.reserve || []).filter(Boolean).length
  };
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function round3(value) {
  return Number(Number(value || 0).toFixed(3));
}


async function rebuildDraftPickOwnership(githubToken, activeLeagueId) {
  const [league, users, rosters, tradedPicks] = await Promise.all([
    getJSON(`${SLEEPER}/league/${activeLeagueId}`),
    getJSON(`${SLEEPER}/league/${activeLeagueId}/users`),
    getJSON(`${SLEEPER}/league/${activeLeagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${activeLeagueId}/traded_picks`)
  ]);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));

  return writeDraftPickOwnershipFile({
    league,
    rosters,
    tradedPicks,
    rosterById,
    userById,
    githubToken,
    generatedAt: new Date().toISOString()
  });
}

async function writeDraftPickOwnershipFile({
  league,
  rosters,
  tradedPicks,
  rosterById,
  userById,
  githubToken,
  generatedAt
}) {
  const picks = buildDraftPickOwnership(league, rosters, tradedPicks, rosterById, userById);
  const byOwner = summarizeDraftPickOwnership(picks, rosters, rosterById, userById);
  const seasons = [...new Set(picks.map(p => p.season))].sort();
  const rounds = Number(league.settings?.draft_rounds || 3);
  const path = "draft-pick-ownership.json";

  const payload = {
    generated_at: generatedAt,
    league: {
      league_id: String(league.league_id),
      name: league.name,
      season: String(league.season),
      draft_rounds: rounds
    },
    covered_draft_seasons: seasons,
    total_picks: picks.length,
    picks,
    by_owner: byOwner
  };

  await upsertGitHubJSON(
    path,
    payload,
    "Update current Sleeper draft-pick ownership",
    githubToken
  );

  return {
    path,
    covered_draft_seasons: seasons,
    total_picks: picks.length,
    owner_count: byOwner.length
  };
}

function summarizeDraftPickOwnership(picks, rosters, rosterById, userById) {
  return rosters.map(roster => {
    const rosterId = Number(roster.roster_id);
    const owned = picks.filter(p => Number(p.current_owner_roster_id) === rosterId);
    const bySeason = {};

    for (const pick of owned) {
      if (!bySeason[pick.season]) {
        bySeason[pick.season] = {
          total: 0,
          round_1: 0,
          round_2: 0,
          round_3: 0,
          other_rounds: 0,
          picks: []
        };
      }

      const bucket = bySeason[pick.season];
      bucket.total += 1;
      if (pick.round === 1) bucket.round_1 += 1;
      else if (pick.round === 2) bucket.round_2 += 1;
      else if (pick.round === 3) bucket.round_3 += 1;
      else bucket.other_rounds += 1;
      bucket.picks.push({
        round: pick.round,
        original_roster_id: pick.original_roster_id,
        original_team: pick.original_team,
        has_been_traded: pick.has_been_traded
      });
    }

    const firsts = owned.filter(p => p.round === 1).length;
    const seconds = owned.filter(p => p.round === 2).length;
    const thirds = owned.filter(p => p.round === 3).length;

    return {
      roster_id: roster.roster_id,
      team_name: teamName(roster.roster_id, rosterById, userById),
      total_future_picks: owned.length,
      first_round_picks: firsts,
      second_round_picks: seconds,
      third_round_picks: thirds,
      other_round_picks: owned.length - firsts - seconds - thirds,
      by_season: bySeason
    };
  }).sort((a, b) =>
    b.first_round_picks - a.first_round_picks ||
    b.total_future_picks - a.total_future_picks ||
    a.roster_id - b.roster_id
  );
}


async function createManualSnapshot(leagueId, githubToken, label) {
  const players = await getPlayers();
  const [league, users, rosters, tradedPicks] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/traded_picks`)
  ]);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));
  const teams = buildTeams(rosters, userById, players);
  const normalizedTradedPicks = tradedPicks.map(p => normalizePick(p, rosterById, userById));
  const draftPickOwnership = buildDraftPickOwnership(league, rosters, tradedPicks, rosterById, userById);
  const generatedAt = new Date().toISOString();
  const season = String(league.season);
  const localDate = dateInTimeZone(new Date(), "America/Chicago");
  const safeLabel = slugify(label);
  const timestamp = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  const suffix = safeLabel ? `-${safeLabel}` : "";
  const path = `snapshots/${season}/events/${timestamp}${suffix}.json`;

  const payload = buildSnapshotPayload({
    snapshotType: "manual_event",
    generatedAt,
    localDate,
    leagueSummary: {
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      name: league.name,
      season,
      status: league.status,
      total_rosters: league.total_rosters,
      settings: league.settings,
      scoring_settings: league.scoring_settings,
      roster_positions: league.roster_positions,
      draft_id: league.draft_id ? String(league.draft_id) : null
    },
    teams,
    tradedPicks: normalizedTradedPicks,
    draftPickOwnership,
    label: safeLabel || null
  });

  await upsertGitHubJSON(path, payload, `Create manual Sleeper snapshot${safeLabel ? `: ${safeLabel}` : ""}`, githubToken);

  return {
    season,
    league_id: String(league.league_id),
    snapshot_path: path,
    label: safeLabel || null,
    generated_at: generatedAt
  };
}

function buildTeams(rosters, userById, players) {
  return rosters.map(roster => {
    const owner = userById[roster.owner_id] || {};
    return {
      roster_id: roster.roster_id,
      owner_id: roster.owner_id,
      username: owner.username || null,
      display_name: owner.display_name || null,
      team_name:
        owner.metadata?.team_name ||
        owner.display_name ||
        owner.username ||
        `Roster ${roster.roster_id}`,
      is_commissioner: Boolean(owner.is_owner),
      settings: roster.settings || {},
      record: {
        wins: roster.settings?.wins ?? 0,
        losses: roster.settings?.losses ?? 0,
        ties: roster.settings?.ties ?? 0,
        points_for:
          Number(roster.settings?.fpts || 0) +
          Number(roster.settings?.fpts_decimal || 0) / 100,
        points_against:
          Number(roster.settings?.fpts_against || 0) +
          Number(roster.settings?.fpts_against_decimal || 0) / 100
      },
      players: (roster.players || []).map(id => playerInfo(id, players)),
      starters: (roster.starters || []).map(id => playerInfo(id, players)),
      taxi: (roster.taxi || []).map(id => playerInfo(id, players)),
      reserve: (roster.reserve || []).map(id => playerInfo(id, players))
    };
  });
}

function buildDraftPickOwnership(league, rosters, tradedPicks, rosterById, userById) {
  const currentSeason = Number(league.season);
  const rounds = Number(league.settings?.draft_rounds || 3);
  const tradedSeasons = tradedPicks
    .map(p => Number(p.season))
    .filter(Number.isFinite);
  const maxSeason = Math.max(currentSeason + 3, ...tradedSeasons, currentSeason + 1);
  const ownership = [];

  for (let season = currentSeason + 1; season <= maxSeason; season++) {
    for (const roster of rosters) {
      for (let round = 1; round <= rounds; round++) {
        const traded = tradedPicks.find(p =>
          Number(p.season) === season &&
          Number(p.round) === round &&
          Number(p.roster_id) === Number(roster.roster_id)
        );
        const ownerRosterId = traded?.owner_id ?? roster.roster_id;

        ownership.push({
          season: String(season),
          round,
          original_roster_id: roster.roster_id,
          original_team: teamName(roster.roster_id, rosterById, userById),
          current_owner_roster_id: ownerRosterId,
          current_team: teamName(ownerRosterId, rosterById, userById),
          previous_owner_roster_id: traded?.previous_owner_id ?? null,
          previous_team: traded?.previous_owner_id != null
            ? teamName(traded.previous_owner_id, rosterById, userById)
            : null,
          has_been_traded: Boolean(traded)
        });
      }
    }
  }

  return ownership;
}

function buildSnapshotPayload({
  snapshotType,
  generatedAt,
  localDate,
  leagueSummary,
  teams,
  tradedPicks,
  draftPickOwnership,
  label = null
}) {
  return {
    snapshot_type: snapshotType,
    label,
    generated_at: generatedAt,
    snapshot_date_local: localDate,
    timezone: "America/Chicago",
    league: leagueSummary,
    teams,
    traded_picks: tradedPicks,
    draft_pick_ownership: draftPickOwnership
  };
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function slugify(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeTransaction(tx, players, rosterById, userById) {
  return {
    transaction_id: String(tx.transaction_id),
    type: tx.type,
    status: tx.status,
    created: tx.created,
    created_iso: tx.created ? new Date(tx.created).toISOString() : null,
    week: tx.sleeper_week,
    leg: tx.leg ?? null,
    creator: tx.creator || null,
    roster_ids: tx.roster_ids || [],
    teams: (tx.roster_ids || []).map(id => ({
      roster_id: id,
      team_name: teamName(id, rosterById, userById)
    })),
    adds: mapPlayerMoves(tx.adds, players, rosterById, userById),
    drops: mapPlayerMoves(tx.drops, players, rosterById, userById),
    draft_picks: (tx.draft_picks || []).map(p => normalizePick(p, rosterById, userById)),
    waiver_budget: tx.waiver_budget || [],
    waiver_bid: tx.settings?.waiver_bid ?? null,
    metadata: tx.metadata || null
  };
}

function normalizePick(p, rosterById, userById) {
  return {
    season: String(p.season),
    round: p.round,
    original_roster_id: p.roster_id,
    previous_owner_roster_id: p.previous_owner_id,
    current_owner_roster_id: p.owner_id,
    original_team: teamName(p.roster_id, rosterById, userById),
    previous_team: teamName(p.previous_owner_id, rosterById, userById),
    current_team: teamName(p.owner_id, rosterById, userById)
  };
}

async function getPlayers() {
  const cache = caches.default;
  const key = new Request("https://sleeper-dynasty-sync.internal/players");
  let response = await cache.match(key);

  if (!response) {
    const upstream = await fetch(`${SLEEPER}/players/nfl`, {
      headers: { "User-Agent": "SleeperDynastySync/4.1" }
    });
    if (!upstream.ok) {
      throw new Error(`${upstream.status} fetching Sleeper player database`);
    }
    response = new Response(upstream.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400"
      }
    });
    await cache.put(key, response.clone());
  }

  return response.json();
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "SleeperDynastySync/4.1"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }
  return response.json();
}

async function getBoundedText(url, maxBytes, label, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/csv,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; SleeperDynastySync/4.1)",
      ...extraHeaders
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${label} from ${url}`);
  }
  return readResponseTextWithLimit(response, maxBytes, label);
}

async function getBoundedJSON(url, maxBytes, label, extraHeaders = {}) {
  const text = await getBoundedText(url, maxBytes, label, extraHeaders);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}


async function getGitHubJSON(path, token) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`;
  const response = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: {
      ...githubHeaders(token),
      "Accept": "application/vnd.github.raw+json"
    }
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed for ${path}: ${response.status} ${text}`);
  }

  const text = await readResponseTextWithLimit(
    response,
    MAX_GITHUB_JSON_BYTES,
    `GitHub file ${path}`
  );
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`GitHub JSON parse failed for ${path}: ${error.message}`);
  }
}

async function readResponseTextWithLimit(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
  }

  if (!response.body) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}


async function createGitHubJSONIfMissing(path, data, message, token) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`;
  const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: githubHeaders(token)
  });

  if (existing.ok) {
    return { path, created: false };
  }
  if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`GitHub read failed for ${path}: ${existing.status} ${text}`);
  }

  const write = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(JSON.stringify(data, null, 2)),
      branch: GITHUB_BRANCH
    })
  });

  if (!write.ok) {
    const text = await write.text();
    throw new Error(`GitHub write failed for ${path}: ${write.status} ${text}`);
  }

  return { path, created: true };
}

async function upsertGitHubJSON(path, data, message, token) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`;
  let sha = null;

  const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: githubHeaders(token)
  });

  if (existing.ok) {
    const existingData = await existing.json();
    sha = existingData.sha || null;
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`GitHub read failed for ${path}: ${existing.status} ${text}`);
  }

  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(data, null, 2)),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  const write = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!write.ok) {
    const text = await write.text();
    throw new Error(`GitHub write failed for ${path}: ${write.status} ${text}`);
  }

  return write.json();
}

function githubHeaders(token) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "SleeperDynastySync/4.1"
  };
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}


function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function dedupeById(items, key) {
  const seen = new Set();
  return items.filter(item => {
    const id = item?.[key];
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function playerInfo(id, players) {
  if (!id) return null;
  const p = players[id];
  if (!p) {
    return {
      player_id: id,
      name: id,
      position: String(id).length <= 4 ? "DEF" : null,
      team: String(id).length <= 4 ? id : null
    };
  }
  return {
    player_id: id,
    name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    position: p.position || null,
    fantasy_positions: p.fantasy_positions || [],
    team: p.team || null,
    status: p.status || null,
    injury_status: p.injury_status || null,
    age: p.age || null,
    years_exp: p.years_exp || null
  };
}

function teamName(rosterId, rosterById, userById) {
  if (rosterId === null || rosterId === undefined) return null;
  const roster = rosterById[String(rosterId)];
  if (!roster) return `Roster ${rosterId}`;
  const user = userById[roster.owner_id] || {};
  return user.metadata?.team_name || user.display_name || user.username || `Roster ${rosterId}`;
}

function mapPlayerMoves(moves, players, rosterById, userById) {
  if (!moves) return [];
  return Object.entries(moves).map(([playerId, rosterId]) => ({
    player: playerInfo(playerId, players),
    roster_id: rosterId,
    team_name: teamName(rosterId, rosterById, userById)
  }));
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
