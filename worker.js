const LEAGUE_ANCHOR_ID = "1327788752298336256";
const LEAGUE_ANCHOR_USER_ID = "1129875387229560832";
const MAX_LEAGUE_CHAIN_LENGTH = 50;
const SLEEPER = "https://api.sleeper.app/v1";
const GITHUB_OWNER = "christianhwill";
const GITHUB_REPO = "sleeper-dynasty-league";
const GITHUB_BRANCH = "main";
const BRIDGE_VERSION = "3.8-auto-season-rollover";
const MAX_GITHUB_JSON_BYTES = 50 * 1024 * 1024;

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
          active_league_route: "/chain",
          github_repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          github_token_configured: Boolean(env.GITHUB_TOKEN)
        });
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
        routes: {
          health: "/health",
          discover_history: "/chain",
          save_history_chain: "/bootstrap",
          sync_current_season: "/sync",
          create_manual_snapshot: "/snapshot?label=OPTIONAL_LABEL",
          rebuild_unified_ledger: "/rebuild-ledger",
          rebuild_draft_pick_ownership: "/rebuild-picks",
          rebuild_owner_tendencies: "/rebuild-tendencies",
          rebuild_power_rankings: "/rebuild-power-rankings",
          rebuild_game_history: "/rebuild-games?season=YYYY",
          finalize_game_history: "/rebuild-games?finalize=1",
          sync_one_season: "/sync-season?league_id=LEAGUE_ID"
        }
      });
    } catch (error) {
      return json({ ok: false, error: error.message, stack: error.stack }, 500);
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
    const chain = await discoverLeagueChain(activeLeagueId);
    const powerRankings = await rebuildPowerRankings(githubToken, activeLeagueId, chain);
    return {
      task: "daily_power_rankings",
      active_league_id: activeLeagueId,
      power_rankings: powerRankings
    };
  }

  if (utcDay === 2 && utcHour === 15) {
    const nflState = await getJSON(`${SLEEPER}/state/nfl`);
    const sameSeason = String(nflState?.season || "") === String(activeLeague.season || "");
    const seasonType = String(nflState?.season_type || "").toLowerCase();
    const gamesAreActive = sameSeason && (seasonType === "regular" || seasonType === "post");

    if (!gamesAreActive) {
      return {
        task: "weekly_game_history_finalize",
        active_league_id: activeLeagueId,
        skipped: true,
        reason: "The active Sleeper season is not in regular-season or postseason play."
      };
    }

    const chain = await discoverLeagueChain(activeLeagueId);
    const finalResult = await rebuildStoredGameHistory(githubToken, activeLeagueId, chain);
    return {
      task: "weekly_game_history_finalize",
      active_league_id: activeLeagueId,
      final_result: finalResult
    };
  }

  return {
    task: "scheduled_noop",
    active_league_id: activeLeagueId,
    utc_hour: utcHour,
    utc_day: utcDay
  };
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

    return {
      season,
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      files_written: files.map(([path]) => path).concat(["current.json", "draft-pick-ownership.json", "owner-tendencies.json", "power-rankings.json"]),
      transaction_count: transactions.length,
      trade_count: trades.length,
      draft_count: draftData.length,
      team_count: teams.length,
      daily_snapshot: dailySnapshotResult,
      draft_pick_ownership_file: draftPickOwnershipResult,
      unified_history: unifiedHistory,
      owner_tendencies: ownerTendencies,
      power_rankings: powerRankings,
      game_history: gameHistory
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


async function rebuildPowerRankings(githubToken, activeLeagueId, providedChain = null) {
  const chainNewestFirst = providedChain || await discoverLeagueChain(activeLeagueId);
  const chain = [...chainNewestFirst].reverse();

  const [currentDoc, pickDoc, previousRankings] = await Promise.all([
    getGitHubJSON("current.json", githubToken),
    getGitHubJSON("draft-pick-ownership.json", githubToken),
    getGitHubJSON("power-rankings.json", githubToken).catch(() => null)
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

    return {
      owner_id: ownerId,
      roster_id: Number(team.roster_id),
      username: team.username || null,
      display_name: team.display_name || null,
      team_name: team.team_name || null,
      competitive_score_raw: competitiveScore,
      draft_capital_raw: pickCapitalRaw,
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

  for (const row of rankingRows) {
    row.competitive_score = round2(competitivePercentiles.get(row.owner_id) || 0);
    row.draft_capital_score = round2(capitalPercentiles.get(row.owner_id) || 0);
    row.baseline_power_score = round2(
      0.7 * row.competitive_score + 0.3 * row.draft_capital_score
    );
    delete row.competitive_score_raw;
    delete row.draft_capital_raw;
  }

  rankingRows.sort((a, b) =>
    b.baseline_power_score - a.baseline_power_score ||
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
    ranking_type: "baseline_internal",
    external_player_values_included: false,
    methodology: {
      purpose: "Objective baseline franchise power ranking before external dynasty market values are added.",
      composite_weights: {
        competitive_score: 0.70,
        future_draft_capital_score: 0.30
      },
      competitive_score: "Uses up to the three most recent seasons with games played. Within each season, 60% win-percentage percentile and 40% points-per-game percentile; most recent played seasons receive weights 3, 2, and 1.",
      future_draft_capital_score: "Current future picks are valued by round (1st=3.0, 2nd=1.5, 3rd=0.75) and discounted by draft year (next draft=1.0, following=0.85, third=0.70), then converted to a league percentile.",
      roster_profile: "Age, experience, and positional counts are descriptive only and are not included in the baseline score.",
      limitation: "Individual player quality and external dynasty market values are not yet included. The external player-value integration is intended to add a true roster-value component in the next phase.",
      movement: "rank_change compares with the previously generated power-rankings.json when one exists; positive means the team moved up."
    },
    performance_seasons_used: Object.entries(performanceWeights).map(([season, weight]) => ({ season, weight })),
    team_count: rankingRows.length,
    rankings: rankingRows
  };

  await upsertGitHubJSON(
    path,
    payload,
    "Update Sleeper baseline power rankings",
    githubToken
  );

  return {
    path,
    ranking_type: payload.ranking_type,
    team_count: rankingRows.length,
    performance_seasons_used: payload.performance_seasons_used,
    external_player_values_included: false
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
      headers: { "User-Agent": "SleeperDynastySync/2.0" }
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
      "User-Agent": "SleeperDynastySync/2.0"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }
  return response.json();
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
    "User-Agent": "SleeperDynastySync/2.0"
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}
