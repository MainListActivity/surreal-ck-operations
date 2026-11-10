/** Database-side, lossless token. Never round-trip a database datetime through JavaScript Date. */
export const outboundRevisionSql = (prefix = '') =>
  `crypto::sha256(type::string([${['body', 'translated_text', 'translated_from_hash', 'lang', 'lang_chosen', 'hold', 'state', 'edited_at', 'created_at'].map(field => `${prefix}${field}`).join(', ')}]))`;
