const CURRENT_LEAGUE_ID = "1327788752298336256";
const SLEEPER = "https://api.sleeper.app/v1";
const GITHUB_OWNER = "christianhwill";
const GITHUB_REPO = "sleeper-dynasty-league";
const GITHUB_BRANCH = "main";
const BRIDGE_VERSION = "3.3-owner-tendencies";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "Sleeper Dynasty Sync",
          version: BRIDGE_VERSION,
          current_league_id: CURRENT_LEAGUE_ID,
          github_repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          github_token_configured: Boolean(env.GITHUB_TOKEN)
        });
      }

      if (!env.GITHUB_TOKEN) {
        return json({ ok: false, error: "GITHUB_TOKEN secret is not configured." }, 500);
      }

      if (url.pathname === "/chain") {
        const chain = await discoverLeagueChain(CURRENT_LEAGUE_ID);
        return json({ ok: true, chain });
      }

      if (url.pathname === "/sync") {
        const result = await syncSeasonToGitHub(CURRENT_LEAGUE_ID, env.GITHUB_TOKEN, true);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/snapshot") {
        const label = url.searchParams.get("label");
        const result = await createManualSnapshot(CURRENT_LEAGUE_ID, env.GITHUB_TOKEN, label);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-ledger") {
        const result = await rebuildUnifiedHistory(env.GITHUB_TOKEN);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-picks") {
        const result = await rebuildDraftPickOwnership(env.GITHUB_TOKEN);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/rebuild-tendencies") {
        const result = await rebuildOwnerTendencies(env.GITHUB_TOKEN);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/sync-season") {
        const leagueId = url.searchParams.get("league_id");
        if (!leagueId) {
          return json({ ok: false, error: "Missing league_id query parameter." }, 400);
        }
        const result = await syncSeasonToGitHub(leagueId, env.GITHUB_TOKEN, leagueId === CURRENT_LEAGUE_ID);
        return json({ ok: true, ...result });
      }

      if (url.pathname === "/bootstrap") {
        const chain = await discoverLeagueChain(CURRENT_LEAGUE_ID);
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
          sync_one_season: "/sync-season?league_id=LEAGUE_ID"
        }
      });
    } catch (error) {
      return json({ ok: false, error: error.message, stack: error.stack }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) return;
    ctx.waitUntil(syncSeasonToGitHub(CURRENT_LEAGUE_ID, env.GITHUB_TOKEN, true));
  }
};

async function discoverLeagueChain(startLeagueId) {
  const seen = new Set();
  const chain = [];
  let leagueId = startLeagueId;

  while (leagueId && leagueId !== "0" && !seen.has(leagueId) && chain.length < 10) {
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
    [`${seasonDir}/drafts.json`, { generated_at: generatedAt, season, drafts: draftData }]
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

    const unifiedHistory = await rebuildUnifiedHistory(githubToken);
    const ownerTendencies = await rebuildOwnerTendencies(githubToken);

    return {
      season,
      league_id: String(league.league_id),
      previous_league_id: league.previous_league_id ? String(league.previous_league_id) : null,
      files_written: files.map(([path]) => path).concat(["current.json", "draft-pick-ownership.json", "owner-tendencies.json"]),
      transaction_count: transactions.length,
      trade_count: trades.length,
      draft_count: draftData.length,
      team_count: teams.length,
      daily_snapshot: dailySnapshotResult,
      draft_pick_ownership_file: draftPickOwnershipResult,
      unified_history: unifiedHistory,
      owner_tendencies: ownerTendencies
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


async function rebuildUnifiedHistory(githubToken) {
  const chainNewestFirst = await discoverLeagueChain(CURRENT_LEAGUE_ID);
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


async function rebuildOwnerTendencies(githubToken) {
  const chainNewestFirst = await discoverLeagueChain(CURRENT_LEAGUE_ID);
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


async function rebuildDraftPickOwnership(githubToken) {
  const [league, users, rosters, tradedPicks] = await Promise.all([
    getJSON(`${SLEEPER}/league/${CURRENT_LEAGUE_ID}`),
    getJSON(`${SLEEPER}/league/${CURRENT_LEAGUE_ID}/users`),
    getJSON(`${SLEEPER}/league/${CURRENT_LEAGUE_ID}/rosters`),
    getJSON(`${SLEEPER}/league/${CURRENT_LEAGUE_ID}/traded_picks`)
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
    headers: githubHeaders(token)
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed for ${path}: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data.content) return null;
  const text = base64ToUtf8(String(data.content).replace(/\s/g, ""));
  return JSON.parse(text);
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
