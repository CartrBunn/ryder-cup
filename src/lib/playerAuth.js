// Players sign in with just name + join code + PIN — no email. To keep Supabase Auth
// (and the auth.uid()-based RLS) working, we derive a hidden synthetic email + password
// that are pure functions of those inputs, so a returning player reproduces the same
// credentials by typing the same three things. The email is never shown in the UI.

export const slug = s =>
  (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

export function playerCreds({ name, code, pin }) {
  const n = slug(name);
  const c = slug(code);
  // email scoped by code so identity is "name within an event"; password reconstructable
  // from code + PIN and always >= 6 chars (Supabase's minimum).
  return {
    email: `${n}.${c}@players.rydercup.app`,
    password: `${c}:${pin}`
  };
}
