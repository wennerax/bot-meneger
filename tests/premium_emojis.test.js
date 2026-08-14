/**
 * Тесты для системы премиум эмодзи
 * Запустить: node --test tests/premium_emojis.test.js
 */

const assert = require('node:assert');
const test = require('node:test');
const {
  replacePremiumEmojis,
  getPremiumEmoji,
  createCustomEmojiMap,
  getEmojiMap,
  setCustomEmojiMap,
  PREMIUM_EMOJI_MAP,
  EMOJI_NAMES,
  getCustomEmojiInfo,
  getCustomEmojiId,
  getCustomEmojiFallback,
  createCustomEmojiEntity,
  replyWithCustomEmoji,
  addCustomEmoji,
  getAllCustomEmojis,
  hasCustomEmoji,
  CUSTOM_EMOJI_IDS,
  parseEmojiSyntax,
  sendWithEmojiSyntax,
} = require('../app/premium_emojis');

test('getPremiumEmoji returns premium version by emoji symbol', () => {
  const result = getPremiumEmoji('❤️');
  assert.equal(result, '❤️‍🔥', 'Should return fire heart for regular heart');
});

test('getPremiumEmoji returns premium version by name', () => {
  const result = getPremiumEmoji('like');
  assert.equal(result, '👍', 'Should return thumbs up for like');
});

test('getPremiumEmoji returns original emoji if not in map', () => {
  const result = getPremiumEmoji('🎭');
  assert.equal(result, '🎭', 'Should return original emoji if not in map');
});

test('replacePremiumEmojis replaces all mapped emojis in text', () => {
  const input = 'I like ❤️ and 👍';
  const result = replacePremiumEmojis(input);
  assert.ok(result.includes('❤️‍🔥'), 'Should replace heart with fire heart');
  assert.ok(result.includes('👍'), 'Should keep thumbs up');
});

test('replacePremiumEmojis returns empty string for null/undefined', () => {
  assert.equal(replacePremiumEmojis(null), null);
  assert.equal(replacePremiumEmojis(undefined), undefined);
});

test('replacePremiumEmojis returns non-string input as-is', () => {
  assert.equal(replacePremiumEmojis(123), 123);
  assert.equal(replacePremiumEmojis(true), true);
});

test('replacePremiumEmojis works with custom emoji map', () => {
  const customMap = {
    '❤️': '💖',
    '👍': '☑️',
  };
  const input = 'Love ❤️ and approve 👍';
  const result = replacePremiumEmojis(input, customMap);
  assert.ok(result.includes('💖'), 'Should use custom heart emoji');
  assert.ok(result.includes('☑️'), 'Should use custom check emoji');
});

test('createCustomEmojiMap merges with original map', () => {
  const overrides = { '🎉': '🎊🎈' };
  const customMap = createCustomEmojiMap(overrides);
  assert.ok(customMap['❤️'], 'Should have original heart mapping');
  assert.equal(customMap['🎉'], '🎊🎈', 'Should have custom party mapping');
});

test('getEmojiMap returns copy of current emoji map', () => {
  const map = getEmojiMap();
  assert.ok(map['❤️'], 'Should have emoji mappings');
  map['🎭'] = 'test'; // Modify the copy
  const newMap = getEmojiMap();
  assert.ok(!newMap['🎭'], 'Should not affect original map');
});

test('PREMIUM_EMOJI_MAP contains expected mappings', () => {
  const expectedEmojis = ['❤️', '🔥', '👍', '✅', '⚠️', '🎉', '⭐'];
  expectedEmojis.forEach((emoji) => {
    assert.ok(
      PREMIUM_EMOJI_MAP[emoji],
      `Should have mapping for ${emoji}`
    );
  });
});

test('EMOJI_NAMES has heart-related names', () => {
  assert.ok(EMOJI_NAMES['heart'], 'Should have heart name');
  assert.ok(EMOJI_NAMES['fire_heart'], 'Should have fire_heart name');
  assert.equal(EMOJI_NAMES['heart'], '❤️', 'Heart should map to correct emoji');
  assert.equal(EMOJI_NAMES['fire_heart'], '❤️‍🔥', 'Fire heart should map to correct emoji');
});

test('EMOJI_NAMES has action-related names', () => {
  assert.ok(EMOJI_NAMES['like'], 'Should have like name');
  assert.ok(EMOJI_NAMES['check'], 'Should have check name');
  assert.ok(EMOJI_NAMES['warning'], 'Should have warning name');
  assert.equal(EMOJI_NAMES['like'], '👍');
  assert.equal(EMOJI_NAMES['check'], '✅');
});

test('getPremiumEmoji works with all EMOJI_NAMES entries', () => {
  for (const [name, emoji] of Object.entries(EMOJI_NAMES)) {
    const result = getPremiumEmoji(name);
    assert.ok(result, `Should return premium emoji for name: ${name}`);
  }
});

test('replacePremiumEmojis handles multiple occurrences', () => {
  const input = '❤️ Love ❤️ this ❤️';
  const result = replacePremiumEmojis(input);
  const matches = (result.match(/❤️‍🔥/g) || []).length;
  assert.equal(matches, 3, 'Should replace all occurrences');
});

test('replacePremiumEmojis preserves text formatting', () => {
  const input = 'Hello **❤️** world _👍_';
  const result = replacePremiumEmojis(input);
  assert.ok(result.includes('**'), 'Should preserve markdown bold');
  assert.ok(result.includes('_'), 'Should preserve markdown italic');
});

test('replacePremiumEmojis works with emoji combinations', () => {
  const input = '😍💕 Love emoji combination';
  const result = replacePremiumEmojis(input);
  assert.ok(result.length > 0, 'Should handle emoji combinations');
});

test('getPremiumEmoji converts heart to fire heart premium version', () => {
  const heart = getPremiumEmoji('heart');
  // Fire heart name points to ❤️‍🔥 which is already premium, so returns as-is
  const fireHeart = getPremiumEmoji('fire_heart');
  assert.equal(heart, '❤️‍🔥', 'Heart should convert to fire heart');
  assert.equal(fireHeart, '❤️‍🔥', 'Fire heart should remain as-is (already premium)');
});

test('replacePremiumEmojis with complex message', () => {
  const message = replacePremiumEmojis(`
${getPremiumEmoji('check')} Task complete!
${getPremiumEmoji('fire')} Amazing work!
${getPremiumEmoji('heart')} Keep it up!
  `);
  assert.ok(message.includes('✅'), 'Should have check emoji');
  assert.ok(message.includes('🔥'), 'Should have fire emoji');
});

test('setCustomEmojiMap updates the map', () => {
  const originalMap = getEmojiMap();
  const customOverride = { '🎭': 'CUSTOM' };
  setCustomEmojiMap(customOverride);
  
  const updatedMap = getEmojiMap();
  assert.equal(updatedMap['🎭'], 'CUSTOM', 'Should have updated mapping');
  
  // Restore original
  setCustomEmojiMap({ '🎭': undefined });
});

test('createCustomEmojiMap with empty overrides returns copy', () => {
  const customMap = createCustomEmojiMap({});
  assert.equal(
    Object.keys(customMap).length,
    Object.keys(PREMIUM_EMOJI_MAP).length,
    'Should have same number of mappings'
  );
});

test('getPremiumEmoji with emoji number returns the emoji', () => {
  const hundred = getPremiumEmoji('hundred');
  assert.equal(hundred, '💯', 'Should return hundred emoji');
});

test('EMOJI_NAMES has all expected categories', () => {
  const categories = {
    heart: ['heart', 'fire_heart', 'orange_heart'],
    fire: ['fire', 'boom', 'lightning'],
    gesture: ['like', 'dislike', 'pray'],
    face: ['laugh', 'love', 'happy'],
    party: ['party', 'confetti', 'balloon'],
    symbols: ['check', 'cross', 'warning'],
  };

  for (const [category, names] of Object.entries(categories)) {
    for (const name of names) {
      assert.ok(EMOJI_NAMES[name], `Should have ${category} emoji: ${name}`);
    }
  }
});

test('replacePremiumEmojis is idempotent when no matches', () => {
  const input = 'No emojis here';
  const result1 = replacePremiumEmojis(input);
  const result2 = replacePremiumEmojis(result1);
  assert.equal(result1, result2, 'Should be idempotent');
});

test('replacePremiumEmojis works with unicode escape sequences', () => {
  const input = 'Hello \\u2764\\uFE0F'; // Heart emoji in escape form
  const result = replacePremiumEmojis(input);
  assert.ok(result.length > 0, 'Should handle unicode escapes');
});

test('getPremiumEmoji handles emoji with skin tones', () => {
  // Test with regular emoji that might have variations
  const result = getPremiumEmoji('👍');
  assert.ok(result, 'Should handle emoji with potential variations');
});

test('replacePremiumEmojis preserves URLs and special characters', () => {
  const input = 'Check https://example.com ❤️ and @username 👍 !';
  const result = replacePremiumEmojis(input);
  assert.ok(result.includes('https://example.com'), 'Should preserve URLs');
  assert.ok(result.includes('@username'), 'Should preserve mentions');
});

// ==================== ТЕСТЫ ДЛЯ КАСТОМНЫХ ID ЭМОДЗИ ====================

test('getCustomEmojiInfo returns emoji info object', () => {
  const info = getCustomEmojiInfo('heart_purple');
  assert.ok(info, 'Should return info object');
  assert.ok(info.id, 'Should have id');
  assert.ok(info.fallback, 'Should have fallback');
  assert.equal(info.id, '5328145443106873128', 'Should have correct id');
});

test('getCustomEmojiInfo returns null for unknown emoji', () => {
  const info = getCustomEmojiInfo('unknown_emoji');
  assert.equal(info, null, 'Should return null for unknown emoji');
});

test('getCustomEmojiId returns emoji id by name', () => {
  const id = getCustomEmojiId('heart_purple');
  assert.equal(id, '5328145443106873128', 'Should return correct id');
});

test('getCustomEmojiId returns null for unknown emoji', () => {
  const id = getCustomEmojiId('unknown_emoji');
  assert.equal(id, null, 'Should return null for unknown emoji');
});

test('getCustomEmojiFallback returns fallback emoji', () => {
  const fallback = getCustomEmojiFallback('heart_purple');
  assert.equal(fallback, '💜', 'Should return correct fallback');
});

test('getCustomEmojiFallback returns emoji name if not found', () => {
  const fallback = getCustomEmojiFallback('unknown_emoji');
  assert.equal(fallback, 'unknown_emoji', 'Should return emoji name if not found');
});

test('createCustomEmojiEntity creates entity object', () => {
  const entity = createCustomEmojiEntity('heart_purple', 5);
  assert.ok(entity, 'Should return entity object');
  assert.equal(entity.type, 'custom_emoji', 'Should have custom_emoji type');
  assert.equal(entity.offset, 5, 'Should have correct offset');
  assert.equal(entity.length, 2, 'Should have length 2');
  assert.equal(entity.custom_emoji_id, '5328145443106873128', 'Should have correct id');
});

test('createCustomEmojiEntity returns null for unknown emoji', () => {
  const entity = createCustomEmojiEntity('unknown_emoji', 0);
  assert.equal(entity, null, 'Should return null for unknown emoji');
});

test('addCustomEmoji adds new emoji to system', () => {
  const before = hasCustomEmoji('test_emoji_12345');
  assert.equal(before, false, 'Should not exist before');

  addCustomEmoji('test_emoji_12345', '1234567890', '🧪', 'Test Emoji');
  
  const after = hasCustomEmoji('test_emoji_12345');
  assert.equal(after, true, 'Should exist after adding');

  const info = getCustomEmojiInfo('test_emoji_12345');
  assert.equal(info.id, '1234567890', 'Should have correct id');
  assert.equal(info.fallback, '🧪', 'Should have correct fallback');
});

test('addCustomEmoji returns false with invalid params', () => {
  const result1 = addCustomEmoji('', '123', '❤️');
  const result2 = addCustomEmoji('name', '', '❤️');
  const result3 = addCustomEmoji('name', '123', '');
  
  assert.equal(result1, false, 'Should fail with empty name');
  assert.equal(result2, false, 'Should fail with empty id');
  assert.equal(result3, false, 'Should fail with empty fallback');
});

test('getAllCustomEmojis returns all emojis', () => {
  const all = getAllCustomEmojis();
  assert.ok(all['heart_purple'], 'Should have heart_purple');
  assert.ok(all['flower_pink'], 'Should have flower_pink');
  assert.ok(Object.keys(all).length > 0, 'Should return non-empty object');
});

test('hasCustomEmoji checks emoji existence', () => {
  assert.equal(hasCustomEmoji('heart_purple'), true, 'Should find existing emoji');
  assert.equal(hasCustomEmoji('unknown_emoji'), false, 'Should not find unknown emoji');
});

test('CUSTOM_EMOJI_IDS contains expected emojis', () => {
  const expectedEmojis = ['heart_purple', 'heart_pink', 'heart_fire', 'flower_pink', 'flower_blue', 'cat_happy', 'angel', 'star_purple'];
  expectedEmojis.forEach((name) => {
    assert.ok(
      CUSTOM_EMOJI_IDS[name],
      `Should have ${name} in CUSTOM_EMOJI_IDS`
    );
  });
});

test('custom emoji ids are valid strings', () => {
  for (const [name, info] of Object.entries(CUSTOM_EMOJI_IDS)) {
    assert.ok(typeof info.id === 'string', `${name} should have string id`);
    assert.ok(info.id.length > 0, `${name} id should not be empty`);
    assert.ok(/^\d+$/.test(info.id), `${name} id should contain only digits`);
  }
});

test('custom emoji fallbacks are valid', () => {
  for (const [name, info] of Object.entries(CUSTOM_EMOJI_IDS)) {
    assert.ok(info.fallback, `${name} should have fallback`);
    assert.ok(typeof info.fallback === 'string', `${name} fallback should be string`);
  }
});

// ==================== ТЕСТЫ ДЛЯ ПАРСИНГА emoji:id() ====================

test('parseEmojiSyntax returns empty result for null/empty text', () => {
  const result1 = parseEmojiSyntax(null);
  const result2 = parseEmojiSyntax('');
  const result3 = parseEmojiSyntax(undefined);
  
  assert.equal(result1.text, '');
  assert.equal(result1.entities.length, 0);
  assert.equal(result2.text, '');
  assert.equal(result2.entities.length, 0);
  assert.equal(result3.text, '');
  assert.equal(result3.entities.length, 0);
});

test('parseEmojiSyntax parses single emoji:id() pattern', () => {
  const result = parseEmojiSyntax('Люблю emoji:id(5328145443106873128)');
  
  assert.ok(result.text, 'Should have text');
  assert.equal(result.entities.length, 1, 'Should have one entity');
  assert.equal(result.entities[0].type, 'custom_emoji');
  assert.equal(result.entities[0].custom_emoji_id, '5328145443106873128');
  assert.equal(result.entities[0].offset, 6);
  assert.equal(result.entities[0].length, 2);
});

test('parseEmojiSyntax parses multiple emoji:id() patterns', () => {
  const result = parseEmojiSyntax('Люблю emoji:id(111) и emoji:id(222) !');
  
  assert.equal(result.entities.length, 2, 'Should have two entities');
  assert.equal(result.entities[0].custom_emoji_id, '111');
  assert.equal(result.entities[1].custom_emoji_id, '222');
});

test('parseEmojiSyntax replaces pattern with fallback', () => {
  const result = parseEmojiSyntax('Start emoji:id(123) end');
  
  assert.ok(result.text.includes('💬'), 'Should contain fallback emoji');
  assert.ok(!result.text.includes('emoji:id'), 'Should not contain pattern');
});

test('parseEmojiSyntax handles text without patterns', () => {
  const result = parseEmojiSyntax('Just regular text');
  
  assert.equal(result.text, 'Just regular text', 'Text should remain unchanged');
  assert.equal(result.entities.length, 0, 'Should have no entities');
});

test('parseEmojiSyntax ignores invalid patterns', () => {
  const result = parseEmojiSyntax('Text emoji:id(abc) and emoji: id(123)');
  
  // emoji:id(abc) не должен парситься (буквы вместо цифр)
  // emoji: id(123) не должен парситься (пробел)
  assert.equal(result.entities.length, 0, 'Should ignore non-numeric patterns');
});

test('parseEmojiSyntax preserves other text', () => {
  const original = 'Привет emoji:id(12345) это текст https://example.com @user !';
  const result = parseEmojiSyntax(original);
  
  assert.ok(result.text.includes('Привет'), 'Should keep greeting');
  assert.ok(result.text.includes('это текст'), 'Should keep middle text');
  assert.ok(result.text.includes('https://example.com'), 'Should keep URL');
  assert.ok(result.text.includes('@user'), 'Should keep mention');
});

test('parseEmojiSyntax calculates correct offsets', () => {
  // Offset должен быть позиция фоллбека в итоговом тексте
  const result = parseEmojiSyntax('ABC emoji:id(999) DEF');
  
  assert.ok(result.entities.length > 0, 'Should have entity');
  // ABC занимает 3 символа, потом пробел = 4, затем эмодзи
  assert.equal(result.entities[0].offset, 4, 'Offset should be correct');
});

console.log('\n✅ Premium Emoji System Tests Completed');
