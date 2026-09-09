function normalizeUsername(username) {
  return String(username || '').trim().replace(/^@/, '').toLowerCase();
}

function getMentionText(user) {
  if (!user) {
    return 'пользователь';
  }
  if (user.username) {
    // Ensure exactly one leading @ and normalized casing
    const name = String(user.username).trim().replace(/^@+/, '');
    return `@${name}`;
  }
  // If object has displayName or first_name, use it
  if (user.displayName) return user.displayName;
  return user.first_name || 'пользователь';
}

async function resolveUsernameTarget(ctx, input, usage, database) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    ctx.reply(`Используйте ${usage}`);
    return null;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    ctx.reply(`Используйте ${usage}`);
    return null;
  }

  const first = parts[0];
  const normalized = normalizeUsername(first);
  if (/^[a-z0-9_]{1,32}$/i.test(normalized)) {
    const username = `@${normalized}`;
    const resolved = database.resolveUsername(ctx.chat.id, username);
    if (resolved) {
      return {
        target: { id: Number(resolved.userId), first_name: resolved.displayName, username: normalized },
        remainingArgs: parts.slice(1).join(' '),
      };
    }

    try {
      const administrators = await ctx.telegram.getChatAdministrators(ctx.chat.id);
      const member = administrators.find((entry) => normalizeUsername(entry?.user?.username) === normalized);
      if (member?.user?.id) {
        return {
          target: {
            id: member.user.id,
            first_name: member.user.first_name || member.user.username || String(member.user.id),
            username: normalized,
          },
          remainingArgs: parts.slice(1).join(' '),
        };
      }
    } catch (error) {
      // ignore and fallback to usage message
    }

    ctx.reply(`Не удалось найти пользователя ${username} среди известных мне участников группы. Ответьте на его сообщение или укажите ID. Используйте ${usage}`);
    return null;
  }

  ctx.reply(`Используйте ${usage}`);
  return null;
}

module.exports = {
  normalizeUsername,
  getMentionText,
  resolveUsernameTarget,
};
