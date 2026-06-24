// ────────────────────────────────────────────────────────────────────────────
// MATE shared tools — 7 tool implementations + schemas
// ────────────────────────────────────────────────────────────────────────────
//
// Verbatim snapshot from mate-chat (supabase/functions/mate-chat/index.ts),
// extracted 2026-06-23. Used by mate-pro-chat to give the agent product the
// same tool surface as the player product, minus player_training_log (which
// reads PDDR tables that agents have no RLS access to).
//
// Source line ranges (mate-chat/index.ts):
//   tool_web_search                    L25-61
//   tool_places_search                 L62-98
//   tool_weather                       L99-124
//   tool_uk_train_times                L125-180
//   tool_fifa_regulations_search       L181-234
//   LEAGUE_CODES                       L239-250
//   tool_football_data                 L251-336
//   WORLD_LEAGUES                      L338-343
//   currentFootballSeasonYear          L344-349
//   tool_world_football_data           L350-431
//   TOOLS_SHARED (schemas)             L488-632 (player_training_log L633-646 dropped)
//
// To re-extract after a mate-chat update, follow the recipe in
// _shared/mate-personas.ts header — same approach, different line ranges.
//
// Env vars expected on the Supabase project (set via `supabase secrets set`):
//   SERP_API_KEY            (web_search, places_search)
//   OPENWEATHER_API_KEY     (weather)
//   TRANSPORT_API_KEY       (uk_train_times)
//   TRANSPORT_APP_ID        (uk_train_times)
//   OPENAI_API_KEY          (fifa_regulations_search — pgvector embeddings)
//   FOOTBALL_DATA_API_KEY   (football_data — football-data.org)
//   API_FOOTBALL_KEY        (world_football_data — RapidAPI)
//
// fifa_regulations_search takes a SupabaseClient because it RPCs the
// `match_regulations` pgvector function — pass the service-role client.
//
// ────────────────────────────────────────────────────────────────────────────

export async function tool_web_search(query: string, country_code = "gb"): Promise<string> {
  const SERP_API_KEY = Deno.env.get("SERP_API_KEY");
  if (!SERP_API_KEY) return "Web search unavailable (no API key configured).";

  try {
    const cc = (country_code || "gb").toLowerCase();
    const res = await fetch(
      `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}&num=5&gl=${cc}&hl=en`
    );
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const data = await res.json();

    // Surface answer box if present (often the cleanest summary)
    const answer = data?.answer_box?.snippet ?? data?.answer_box?.answer ?? "";
    const knowledge = data?.knowledge_graph?.description ?? "";

    const organic = (data?.organic_results ?? []).slice(0, 5);
    if (!answer && !knowledge && organic.length === 0) {
      return `No results found for "${query}".`;
    }

    const lines: string[] = [];
    if (answer) lines.push(`Answer box: ${answer}`);
    if (knowledge) lines.push(`Knowledge: ${knowledge}`);
    if (organic.length > 0) {
      lines.push("Top results:");
      organic.forEach((r: any, i: number) => {
        lines.push(`${i + 1}. ${r.title}\n   ${r.snippet ?? ""}\n   ${r.link}`);
      });
    }
    return lines.join("\n");
  } catch (err) {
    return `Web search error: ${String(err)}`;
  }
}

// — Local business / places search via SerpApi google_local engine
export async function tool_places_search(query: string, location: string): Promise<string> {
  const SERP_API_KEY = Deno.env.get("SERP_API_KEY");
  if (!SERP_API_KEY) return "Places search unavailable (no API key configured).";

  try {
    const res = await fetch(
      `https://serpapi.com/search.json?engine=google_local&q=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&api_key=${SERP_API_KEY}&hl=en`
    );
    if (!res.ok) return `Places search failed: HTTP ${res.status}`;
    const data = await res.json();

    const places = (data?.local_results ?? []).slice(0, 5);
    if (places.length === 0) {
      // Fallback to regular search if google_local returned nothing
      return await tool_web_search(`${query} ${location}`, "gb");
    }

    const formatted = places.map((p: any, i: number) => {
      const parts = [
        `${i + 1}. ${p.title}`,
        p.rating ? `★ ${p.rating} (${p.reviews ?? "?"} reviews)` : null,
        p.type ? `Type: ${p.type}` : null,
        p.address ? `Address: ${p.address}` : null,
        p.phone ? `Phone: ${p.phone}` : null,
        p.hours ? `Hours: ${p.hours}` : null,
        p.website ? `Web: ${p.website}` : null,
      ].filter(Boolean);
      return parts.join("\n   ");
    }).join("\n\n");

    return `Places found for "${query}" in ${location}:\n\n${formatted}`;
  } catch (err) {
    return `Places search error: ${String(err)}`;
  }
}

// — Weather via OpenWeatherMap — any city worldwide
export async function tool_weather(city: string, country_code?: string): Promise<string> {
  const WEATHER_API_KEY = Deno.env.get("OPENWEATHER_API_KEY");
  if (!WEATHER_API_KEY) return "Weather data unavailable (no API key configured).";

  try {
    const q = country_code ? `${city},${country_code.toUpperCase()}` : city;
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${WEATHER_API_KEY}&units=metric`
    );
    if (!res.ok) return `Weather lookup failed for "${q}" (HTTP ${res.status}).`;
    const data = await res.json();

    const temp = Math.round(data.main.temp);
    const feels = Math.round(data.main.feels_like);
    const desc = data.weather[0].description;
    const wind = Math.round(data.wind.speed * 3.6);
    const humidity = data.main.humidity;
    const country = data.sys?.country ?? "";

    return `Weather in ${data.name}${country ? ", " + country : ""}: ${temp}°C (feels ${feels}°C), ${desc}. Wind ${wind} km/h, humidity ${humidity}%.`;
  } catch (err) {
    return `Weather error: ${String(err)}`;
  }
}

// — UK train times via TransportAPI
export async function tool_uk_train_times(from_station: string, to_station: string): Promise<string> {
  const TRANSPORT_API_KEY = Deno.env.get("TRANSPORT_API_KEY");
  const TRANSPORT_APP_ID = Deno.env.get("TRANSPORT_APP_ID");
  if (!TRANSPORT_API_KEY || !TRANSPORT_APP_ID) return "UK train data unavailable (no API key configured).";

  const stationCodes: Record<string, string> = {
    slough: "SLO",
    london: "PAD",
    paddington: "PAD",
    "london paddington": "PAD",
    waterloo: "WAT",
    "london waterloo": "WAT",
    victoria: "VIC",
    "london victoria": "VIC",
    "london bridge": "LBG",
    euston: "EUS",
    "london euston": "EUS",
    "kings cross": "KGX",
    "king's cross": "KGX",
    reading: "RDG",
    windsor: "WNS",
    oxford: "OXF",
    bristol: "BRI",
    manchester: "MAN",
    birmingham: "BHM",
    liverpool: "LIV",
    cambridge: "CBG",
  };

  try {
    const fromKey = from_station.trim().toLowerCase();
    const toKey = to_station.trim().toLowerCase();
    const fromCode = stationCodes[fromKey] ?? fromKey.slice(0, 3).toUpperCase();
    const toCode = stationCodes[toKey] ?? toKey.slice(0, 3).toUpperCase();

    const res = await fetch(
      `https://transportapi.com/v3/uk/train/station/${fromCode}/live.json?app_id=${TRANSPORT_APP_ID}&app_key=${TRANSPORT_API_KEY}&destination=${toCode}&train_status=passenger`
    );
    if (!res.ok) return `Train lookup failed (HTTP ${res.status}). Check station names.`;
    const data = await res.json();

    const departures = (data?.departures?.all ?? []).slice(0, 5);
    if (departures.length === 0) {
      return `No upcoming trains found from ${from_station} to ${to_station}.`;
    }
    const lines = departures.map(
      (d: any) =>
        `${d.aimed_departure_time} → ${d.destination_name} | Platform ${d.platform ?? "TBC"} | ${d.status}`
    );
    return `Next trains from ${from_station} to ${to_station}:\n${lines.join("\n")}`;
  } catch (err) {
    return `Train lookup error: ${String(err)}`;
  }
}

// — FIFA / FA / UEFA regulation search via RAG (pgvector + OpenAI embeddings)
export async function tool_fifa_regulations_search(
  supabase: any,
  query: string,
  category: string | null = null
): Promise<string> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) return "Regulations search unavailable (no OpenAI key).";

  try {
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: query,
      }),
    });
    if (!embedRes.ok) return `Embedding failed: HTTP ${embedRes.status}`;
    const embedData = await embedRes.json();
    const queryEmbedding = embedData.data?.[0]?.embedding;
    if (!queryEmbedding) return "No embedding returned.";

    const { data, error } = await supabase.rpc("match_regulations", {
      query_embedding: queryEmbedding,
      match_count: 5,
      filter_category: category,
    });
    if (error) return `Vector search error: ${error.message}`;
    if (!data || data.length === 0) return `No relevant regulations found for "${query}".`;

    const filtered = data.filter((r: any) => r.similarity > 0.4);
    if (filtered.length === 0) return `No high-relevance regulations found for "${query}".`;

    const formatted = filtered
      .map((r: any) => {
        const header = [
          r.source,
          r.article ? r.article : null,
          r.title ? `— ${r.title}` : null,
        ].filter(Boolean).join(" ");
        return `[${header}] (relevance ${Math.round(r.similarity * 100)}%)\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return `Official regulations (cite these in your response):\n\n${formatted}`;
  } catch (err) {
    return `Regulations search error: ${String(err)}`;
  }
}

// — League standings or fixtures across major European competitions (football-data.org)

export const LEAGUE_CODES: Record<string, { code: string; label: string }> = {
  premier_league:  { code: "PL",  label: "English Premier League" },
  championship:    { code: "ELC", label: "English Championship" },
  la_liga:         { code: "PD",  label: "Spanish La Liga" },
  serie_a:         { code: "SA",  label: "Italian Serie A" },
  bundesliga:      { code: "BL1", label: "German Bundesliga" },
  ligue_1:         { code: "FL1", label: "French Ligue 1" },
  eredivisie:      { code: "DED", label: "Dutch Eredivisie" },
  primeira_liga:   { code: "PPL", label: "Portuguese Primeira Liga" },
  champions_league:{ code: "CL",  label: "UEFA Champions League" },
};

export async function tool_football_data(
  type: "standings" | "fixtures",
  league = "premier_league",
  team_name?: string
): Promise<string> {
  const FOOTBALL_API_KEY = Deno.env.get("FOOTBALL_DATA_API_KEY");
  if (!FOOTBALL_API_KEY) return "Football data unavailable (no API key configured).";

  const meta = LEAGUE_CODES[league];
  if (!meta) {
    return `League '${league}' is not in the football-data.org free tier (covered: ${Object.keys(LEAGUE_CODES).join(", ")}). Use web_search for this competition.`;
  }

  try {
    if (type === "standings") {
      const res = await fetch(
        `https://api.football-data.org/v4/competitions/${meta.code}/standings`,
        { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
      );
      if (res.status === 403) {
        return `${meta.label} requires a paid football-data.org tier. Use web_search for this competition.`;
      }
      if (!res.ok) return `Standings fetch failed for ${meta.label}: HTTP ${res.status}`;
      const data = await res.json();
      const table = data?.standings?.[0]?.table?.slice(0, 12) ?? [];
      if (table.length === 0) return `No standings data returned for ${meta.label}.`;
      const formatted = table
        .map(
          (t: any) =>
            `${t.position}. ${t.team.name} — ${t.points}pts (${t.won}W ${t.draw}D ${t.lost}L, GD ${t.goalDifference >= 0 ? "+" : ""}${t.goalDifference})`
        )
        .join("\n");
      return `${meta.label} — current table (top 12):\n${formatted}`;
    }

    if (type === "fixtures") {
      const today = new Date().toISOString().split("T")[0];
      const nextTwoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];
      const res = await fetch(
        `https://api.football-data.org/v4/competitions/${meta.code}/matches?dateFrom=${today}&dateTo=${nextTwoWeeks}`,
        { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
      );
      if (res.status === 403) {
        return `${meta.label} requires a paid football-data.org tier. Use web_search for this competition.`;
      }
      if (!res.ok) return `Fixtures fetch failed for ${meta.label}: HTTP ${res.status}`;
      const data = await res.json();
      let matches: any[] = data?.matches ?? [];

      if (team_name) {
        const needle = team_name.trim().toLowerCase();
        matches = matches.filter(
          (m: any) =>
            m.homeTeam?.name?.toLowerCase().includes(needle) ||
            m.awayTeam?.name?.toLowerCase().includes(needle) ||
            m.homeTeam?.shortName?.toLowerCase().includes(needle) ||
            m.awayTeam?.shortName?.toLowerCase().includes(needle)
        );
      }

      matches = matches.slice(0, 8);
      if (matches.length === 0) {
        return team_name
          ? `No upcoming ${meta.label} fixtures for '${team_name}' in the next 14 days.`
          : `No upcoming ${meta.label} fixtures in the next 14 days.`;
      }

      const formatted = matches
        .map(
          (m: any) =>
            `${m.homeTeam.name} vs ${m.awayTeam.name} — ${new Date(m.utcDate).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
        )
        .join("\n");
      const header = team_name
        ? `Upcoming ${meta.label} fixtures for '${team_name}':`
        : `Upcoming ${meta.label} fixtures (next 14 days):`;
      return `${header}\n${formatted}`;
    }

    return `Unknown football_data type: ${type}`;
  } catch (err) {
    return `Football data error: ${String(err)}`;
  }
}

// — Football leagues NOT covered by football-data.org free tier: Scottish Premiership,

export const WORLD_LEAGUES: Record<string, { id: number; label: string }> = {
  scottish_premiership:     { id: 179, label: "Scottish Premiership" },
  ukrainian_premier_league: { id: 333, label: "Ukrainian Premier League" },
  belgian_pro_league:       { id: 144, label: "Belgian Pro League" },
};

export function currentFootballSeasonYear(): number {
  // European football season runs Jul–May. Months Jan–Jun belong to previous calendar year's season.
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

export async function tool_world_football_data(
  type: "standings" | "fixtures",
  league: string,
  team_name?: string
): Promise<string> {
  const KEY = Deno.env.get("API_FOOTBALL_KEY");
  if (!KEY) return "world_football_data unavailable (API_FOOTBALL_KEY not configured).";

  const meta = WORLD_LEAGUES[league];
  if (!meta) {
    return `League '${league}' not supported by world_football_data. Supported: ${Object.keys(WORLD_LEAGUES).join(", ")}. Use web_search for any other competition.`;
  }

  const season = currentFootballSeasonYear();
  const headers = { "x-apisports-key": KEY };
  const baseUrl = "https://v3.football.api-sports.io";

  try {
    if (type === "standings") {
      const res = await fetch(
        `${baseUrl}/standings?league=${meta.id}&season=${season}`,
        { headers }
      );
      if (!res.ok) return `Standings fetch failed for ${meta.label}: HTTP ${res.status}`;
      const data = await res.json();
      const groups = data?.response?.[0]?.league?.standings ?? [];
      const table = (groups[0] ?? []).slice(0, 12);
      if (table.length === 0) {
        return `No standings returned for ${meta.label} season ${season}. The season may not have started or the API may be rate-limited — fall back to web_search.`;
      }
      const formatted = table.map((t: any) => {
        const gd = (t.all?.goals?.for ?? 0) - (t.all?.goals?.against ?? 0);
        return `${t.rank}. ${t.team.name} — ${t.points}pts (${t.all.win}W ${t.all.draw}D ${t.all.lose}L, GD ${gd >= 0 ? "+" : ""}${gd})`;
      }).join("\n");
      return `${meta.label} ${season}/${String(season + 1).slice(-2)} — current table (top 12):\n${formatted}`;
    }

    if (type === "fixtures") {
      const res = await fetch(
        `${baseUrl}/fixtures?league=${meta.id}&season=${season}&next=20`,
        { headers }
      );
      if (!res.ok) return `Fixtures fetch failed for ${meta.label}: HTTP ${res.status}`;
      const data = await res.json();
      let fixtures: any[] = data?.response ?? [];

      if (team_name) {
        const needle = team_name.trim().toLowerCase();
        fixtures = fixtures.filter(
          (f: any) =>
            f.teams.home.name.toLowerCase().includes(needle) ||
            f.teams.away.name.toLowerCase().includes(needle)
        );
      }

      fixtures = fixtures.slice(0, 8);
      if (fixtures.length === 0) {
        return team_name
          ? `No upcoming ${meta.label} fixtures for '${team_name}'.`
          : `No upcoming ${meta.label} fixtures returned by the API.`;
      }

      const formatted = fixtures.map((f: any) => {
        const d = new Date(f.fixture.date).toLocaleDateString("en-GB", {
          weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
        });
        return `${f.teams.home.name} vs ${f.teams.away.name} — ${d}`;
      }).join("\n");

      const header = team_name
        ? `Upcoming ${meta.label} fixtures for '${team_name}':`
        : `Upcoming ${meta.label} fixtures:`;
      return `${header}\n${formatted}`;
    }

    return `Unknown world_football_data type: ${type}`;
  } catch (err) {
    return `world_football_data error: ${String(err)}`;
  }
}

// — Player training log lookup

// ────────────────────────────────────────────────────────────────────────────
// TOOLS_SHARED — Anthropic Tool Use schemas (verbatim from mate-chat L488-632)
// player_training_log entry deliberately dropped — agents have no PDDR access.
// ────────────────────────────────────────────────────────────────────────────
export const TOOLS_SHARED = [
  {
    name: "web_search",
    description:
      "Search the public web for current, time-sensitive, or location-specific information that is not in your training data. Use this whenever the user asks about news, recent events, prices, schedules, public figures' current status, or anything you are not certain about. ALWAYS prefer searching over guessing or saying you don't know. Returns top web results with snippets and source URLs.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in natural language. Be specific — include city names, dates, and proper nouns when relevant.",
        },
        country_code: {
          type: "string",
          description: "2-letter country code for localised results (e.g. 'ua' for Ukraine, 'gb' for UK, 'us' for USA, 'es' for Spain). Default 'gb'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "places_search",
    description:
      "Find local businesses, restaurants, shops, gyms, clinics, services — anything with a physical address. Returns names, addresses, phone numbers, ratings, opening hours and websites. Use for questions like 'where can I find X in Y city', 'best barber shop in Z', 'physiotherapist near Slough', 'restaurants in Dnipro'.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What kind of business to find (e.g. 'barbershop', 'physiotherapy clinic', 'sushi restaurant', 'football boots shop').",
        },
        location: {
          type: "string",
          description: "City and country (e.g. 'Dnipro, Ukraine', 'Slough, UK', 'Madrid, Spain'). Always include the country for accuracy.",
        },
      },
      required: ["query", "location"],
    },
  },
  {
    name: "weather",
    description:
      "Get current weather conditions for any city worldwide. Use for outdoor training planning, travel preparation, match-day conditions, or any 'what's the weather like in X' question.",
    input_schema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name (e.g. 'London', 'Kyiv', 'Madrid').",
        },
        country_code: {
          type: "string",
          description: "Optional 2-letter country code (e.g. 'GB', 'UA', 'ES'). Helps disambiguate cities with the same name.",
        },
      },
      required: ["city"],
    },
  },
  {
    name: "uk_train_times",
    description:
      "Get live train departure times between two UK National Rail stations. UK ONLY — do not use for trains in any other country (use web_search instead for non-UK rail). Common stations: Slough, London Paddington, London Waterloo, Reading, Windsor, Oxford, Manchester.",
    input_schema: {
      type: "object",
      properties: {
        from_station: {
          type: "string",
          description: "UK departure station name (e.g. 'Slough', 'London Paddington').",
        },
        to_station: {
          type: "string",
          description: "UK destination station name.",
        },
      },
      required: ["from_station", "to_station"],
    },
  },
  {
    name: "fifa_regulations_search",
    description:
      "Search the official FIFA, FA and UEFA regulations corpus (RSTP, FFAR, statutes, FA Rules) via semantic search. Returns relevant articles with citations. ALWAYS use this for ANY legal, contract, transfer, agent or compliance question — never rely on your training data alone for football regulations, as they update frequently and citations matter.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The legal or regulatory question (e.g. 'release clause requirements', 'agent commission limits', 'training compensation under 23').",
        },
        category: {
          type: "string",
          description: "Optional filter to narrow the corpus. Leave blank unless certain.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "football_data",
    description:
      "Get current league standings (table, points, W/D/L, goal difference — top 12) or upcoming fixtures (next 14 days, optionally filtered to one team) for major European competitions. Supported leagues: 'premier_league', 'championship', 'la_liga', 'serie_a', 'bundesliga', 'ligue_1', 'eredivisie', 'primeira_liga', 'champions_league'. For NON-supported competitions (Scottish Premiership, Ukrainian Premier League, Belgian Pro League, etc.) call web_search INSTEAD of this tool — do not try unsupported league names here.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["standings", "fixtures"],
          description: "'standings' for league table, 'fixtures' for upcoming matches.",
        },
        league: {
          type: "string",
          enum: ["premier_league", "championship", "la_liga", "serie_a", "bundesliga", "ligue_1", "eredivisie", "primeira_liga", "champions_league"],
          description: "Which competition. Defaults to 'premier_league' if omitted.",
        },
        team_name: {
          type: "string",
          description: "Optional. For type='fixtures' only. Filter matches to a specific team (e.g. 'Real Madrid', 'Inter', 'Bayern'). Matched case-insensitively against full and short team names.",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "world_football_data",
    description:
      "Get current standings or upcoming fixtures for football leagues NOT covered by the main football_data tool: Scottish Premiership ('scottish_premiership'), Ukrainian Premier League ('ukrainian_premier_league'), Belgian Pro League ('belgian_pro_league'). Use this when the player or transfer query involves a club in one of these countries (e.g. Motherwell, Shakhtar, Anderlecht). For any other competition not listed here AND not in football_data — use web_search.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["standings", "fixtures"],
          description: "'standings' for league table, 'fixtures' for upcoming matches.",
        },
        league: {
          type: "string",
          enum: ["scottish_premiership", "ukrainian_premier_league", "belgian_pro_league"],
          description: "Which competition.",
        },
        team_name: {
          type: "string",
          description: "Optional. For type='fixtures' only. Filter matches to a specific club (e.g. 'Motherwell', 'Shakhtar Donetsk', 'Club Brugge'). Case-insensitive substring match.",
        },
      },
      required: ["type", "league"],
    },
  },
];
