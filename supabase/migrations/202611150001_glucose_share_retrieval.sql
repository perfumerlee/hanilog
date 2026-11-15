-- Short-lived bearer links are encrypted by the Edge Function before storage.
-- The table has RLS enabled and no client grants.
alter table public.glucose_share_links
  add column share_token_ciphertext text,
  add column recipient_phone text;

alter table public.glucose_share_links
  add constraint glucose_share_recipient_phone_format check (recipient_phone is null or recipient_phone ~ '^\+?[0-9]{8,15}$');

comment on column public.glucose_share_links.share_token_ciphertext is
  'AES-GCM encrypted short-lived bearer token; decrypted only by the service-role share function after caregiver authorization.';
