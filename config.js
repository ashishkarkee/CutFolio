// From Supabase → Project Settings → API Keys.
// The publishable key is safe to publish: the database only lets the signed-in barber see his data.
// Never put the secret (service_role) key here.
window.CUTFOLIO_CONFIG = {
  supabaseUrl: 'https://euohjxiopeufjqtsrugm.supabase.co',
  supabaseAnonKey: 'sb_publishable_f9Pj6hblCtIlqm-etI5XCQ_W64WLEz5',
  // The Supabase user the app signs in as. The barber only types the password,
  // and stays signed in on his phone until he taps Sign out.
  loginEmail: 'barber@cutfolio.app',
  // Email reminders: the RemindersUrl that `sam deploy` prints (see aws/README.md).
  // Leave blank and the app works the same, it just doesn't send emails.
  remindersUrl: 'https://aebqpyihzpdcxb2hlutog74j2q0gvqup.lambda-url.us-east-2.on.aws/',
};
