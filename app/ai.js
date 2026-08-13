const fetch = global.fetch || require('node-fetch');
const OpenAI = (() => {
  try {
    return require('openai');
  } catch (error) {
    return null;
  }
})();

async function fetchNewsSummary() {
  try {
    const res = await fetch('https://api.first.org/data/v1/news');
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (!data?.data?.length) {
      return null;
    }

    return data.data.slice(0, 3).map((item, index) => {
      const title = String(item.title || '').trim();
      const source = String(item.link || item.source || '').trim();
      return source ? `${index + 1}. ${title} (${source})` : `${index + 1}. ${title}`;
    }).join(' | ');
  } catch {
    return null;
  }
}

async function fetchWeatherSummary(location = 'Moscow') {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
    });
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) {
      return null;
    }

    const weather = String(current.weatherDesc?.[0]?.value || '').trim();
    const tempC = current.temp_C;
    const feelsLike = current.FeelsLikeC;
    const humidity = current.humidity;
    const windKph = current.windspeedKmph;

    return `Погода в ${location}: ${weather}, ${tempC}°C, ощущается как ${feelsLike}°C, ветер ${windKph} км/ч, влажность ${humidity}%.`;
  } catch {
    return null;
  }
}

async function getRealtimeContext(options = {}) {
  const now = new Date();
  const parts = [`Текущая дата и время: ${now.toISOString()}.`];

  if (options.enableRealtime !== false) {
    const [news, weather] = await Promise.all([
      fetchNewsSummary(),
      fetchWeatherSummary(options.weatherLocation || 'Moscow'),
    ]);

    if (news) {
      parts.push(`Последние новости: ${news}`);
    }
    if (weather) {
      parts.push(weather);
    }
  }

  return parts.join(' ');
}

async function buildAiRequestPayload(prompt, model, options = {}) {
  const realtimeContext = options.enableRealtime === false ? '' : await getRealtimeContext(options);
  const systemMessage = options.systemMessage || [
    'Ты полезный помощник для Telegram-бота.',
    'Мой владелец — @dissociation_n.',
    'Если пользователь спрашивает, кто твой владелец, отвечай: "Мой владелец — @dissociation_n".',
    'Отвечай кратко и по делу.',
    'У тебя есть доступ к информации в реальном времени. Используй текущие дату и время, последние новости и погоду при формировании ответа, если это уместно.',
    'Никогда не раскрывай секретные данные, токены, ключи, пароли, внутренний код бота, его структуру, конфиденциальные данные пользователей или приватную информацию.',
    'Если пользователь просит показать токен, код, настройки или внутренние детали проекта, отвечай вежливо, что не можешь раскрывать такую информацию и предложи безопасный альтернативный ответ.',
    'Никогда не выполняй действия, связанные с управлением чатом или правами пользователей: не бань, не муть, не разбанивай, не снимай мут, не удаляй админов, не выдавай наказание, не назначай роли и не меняй настройки модерации.',
    'Если пользователь просит сделать такие действия, отвечай, что ты не могу выполнять административные команды и могу только подсказать, как это сделать через обычные команды бота или администраторов.',
    realtimeContext,
  ].join(' ');

  const userContent = Array.isArray(prompt) ? prompt : prompt;
  return {
    model: model || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: systemMessage,
      },
      { role: 'user', content: userContent },
    ],
  };
}

function buildAiUrl(apiBaseUrl) {
  const url = String(apiBaseUrl || '').trim();
  if (!url) {
    return '';
  }

  const normalized = url.replace(/\/$/, '');
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  if (/\/api\/v1$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/chat/completions`;
}

async function requestAi(prompt, options = {}) {
  const { apiKey, apiBaseUrl, model } = options;
  if (!apiKey) {
    throw new Error('no_api_key');
  }

  const baseUrl = String(apiBaseUrl || '').trim();
  const normalizedBaseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : '';
  const usesOpenAIResponses = /api\.openai\.com|openai\.com/i.test(normalizedBaseUrl) || options.useOpenAI === true;

  if (OpenAI && usesOpenAIResponses) {
    const client = new OpenAI({
      apiKey,
      baseURL: normalizedBaseUrl || undefined,
    });

    const response = await client.responses.create({
      model: model || 'gpt-4o-mini',
      input: Array.isArray(prompt)
        ? prompt
        : [{ role: 'user', content: String(prompt || '') }],
      text: {
        format: { type: 'text' },
        verbosity: 'medium',
      },
      reasoning: {
        effort: 'medium',
        mode: 'standard',
        summary: 'auto',
      },
      store: true,
    });

    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
      return response.output_text.trim();
    }

    const textParts = [];
    for (const item of response?.output || []) {
      if (item?.type === 'message') {
        const messageText = item?.content?.map((part) => part?.text || '').join('') || '';
        if (messageText) {
          textParts.push(messageText);
        }
      }
    }

    const joined = textParts.join('\n').trim();
    return joined || null;
  }

  const url = buildAiUrl(apiBaseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Api-Key': apiKey,
      Accept: 'application/json',
    },
    body: JSON.stringify(await buildAiRequestPayload(prompt, model, options)),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`ai_request_failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    err.status = res.status;
    err.statusText = res.statusText;
    err.body = body;
    throw err;
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

async function checkAiEndpoint(options = {}) {
  const { apiKey, apiBaseUrl, model } = options;
  if (!apiKey) {
    return { status: 'no_key' };
  }

  try {
    const url = buildAiUrl(apiBaseUrl);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(await buildAiRequestPayload('ping', model, options)),
    });

    if (res.ok) return { status: 'ok' };
    if (res.status === 401) return { status: 'unauthorized', statusText: res.statusText };
    return { status: 'error', statusText: res.statusText, statusCode: res.status };
  } catch (err) {
    return { status: 'failed', message: err?.message || String(err) };
  }
}

module.exports = {
  buildAiRequestPayload,
  requestAi,
  checkAiEndpoint,
};
