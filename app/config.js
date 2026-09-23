// Public Supabase settings. Both values are safe to publish: every table is protected by
// Row Level Security. Never put the service-role or secret key here or anywhere in this repo.
window.UPHELD_CONFIG = {
  supabaseUrl: 'https://vyiznjphjwehawdzapce.supabase.co',
  supabaseKey: 'sb_publishable_BeFA87mKNJf756tWM-u6PA_BwX190JU',
  // Public half of the web push (VAPID) key pair. The private half is the Supabase secret VAPID_PRIVATE_KEY.
  // Empty until notifications are set up; the app then shows "Notifications aren't switched on yet."
  vapidPublicKey: 'BHfR__g0xX91znsp4D5KEG9HPplVhGCesF1WEDF0cArUHXW6QP-fsJdKbRA3CaB2hsMJGcwlnIYdcCGPB7F3qeg'
};
