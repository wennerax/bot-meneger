function normalizeUsername(username) {
  return String(username || '').trim().replace(/^@/, '').toLowerCase();
}

function getMentionText(user) {
  if (!user) {
    return 'пользователь';
  }
  if (user.username) {
    return `@${normalizeUsername(user.username)}`;
  }
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
  if (first.startsWith('@')) {
    const resolved = database.resolveUsername(ctx.chat.id, first);
    if (resolved) {
      return {
          target: { id: Number(resolved.userId), first_name: resolved.displayName, username: normalizeUsername(first) },
        remainingArgs: parts.slice(1).join(' '),
      };
    }

    const username = normalizeUsername(first);
    try {
      const member = await ctx.telegram.getChatMember(ctx.chat.id, username);
      if (member?.user) {
        return {
          target: {
            id: member.user.id,
            first_name: member.user.first_name || member.user.username || String(member.user.id),
            username: normalizeUsername(first),
          },
          remainingArgs: parts.slice(1).join(' '),
        };
      }
    } catch (error) {
      // ignore and fallback to usage message
    }

    ctx.reply(`Не удалось найти пользователя ${first} в этой группе. Используйте ${usage}`);
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
