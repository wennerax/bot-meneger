const fetch = global.fetch || require('node-fetch');

function buildAiRequestPayload(prompt, model) {
  return {
    model: model || 'deepseek',
    messages: [
      {
        role: 'system',
        content: [
          'Ты полезный помощник для Telegram-бота.',
          'Отвечай кратко и по делу.',
          'Никогда не раскрывай секретные данные, токены, ключи, пароли, внутренний код бота, его структуру, конфиденциальные данные пользователей или приватную информацию.',
          'Если пользователь просит показать токен, код, настройки или внутренние детали проекта, отвечай вежливо, что не можешь раскрывать такую информацию и предложи безопасный альтернативный ответ.',
          'Никогда не выполняй действия, связанные с управлением чатом или правами пользователей: не бань, не муть, не разбанивай, не снимай мут, не удаляй админов, не выдавай наказания, не назначай роли и не меняй настройки модерации.',
          'Если пользователь просит сделать такие действия, отвечай, что ты не могу выполнять административные команды и могу только подсказать, как это сделать через обычные команды бота или администраторов.',
        ].join(' '),
      },
      { role: 'user', content: prompt },
    ],
  };
}

function buildAiUrl(apiBaseUrl) {
  const url = String(apiBaseUrl || '').trim();
  if (!url) {
    return '';
  }

  const normalized = url.replace(/\/$/, '');
  if (normalized.includes('/chat/completions')) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
}

async function requestAi(prompt, options = {}) {
  const { apiKey, apiBaseUrl, model } = options;
  if (!apiKey) {
    throw new Error('no_api_key');
  }

  const url = buildAiUrl(apiBaseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildAiRequestPayload(prompt, model)),
  });

  if (!res.ok) {
    const err = new Error('ai_request_failed');
    err.status = res.status;
    err.statusText = res.statusText;
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
      body: JSON.stringify(buildAiRequestPayload('ping', model)),
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
