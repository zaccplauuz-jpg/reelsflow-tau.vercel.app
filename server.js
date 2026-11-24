-- Adiciona um marcador independente para ocultar contas removidas do painel.
-- Seguro para executar em bancos que já possuem a tabela.
alter table public.instagram_accounts
  add column if not exists is_hidden boolean not null default false;

-- Permite que o painel leia o novo campo junto dos demais dados não sensíveis.
grant select (id, owner_id, instagram_user_id, username, account_type, token_expires_at, connection_status, is_hidden, created_at, updated_at)
  on public.instagram_accounts to authenticated;
