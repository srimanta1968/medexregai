-- F8.1: a signed-in person may read their OWN memberships in every firm (to choose the firm they
-- land in at sign-in, token refresh and SSO), and nothing else across firms. DataService sets
-- app.user_id for the transaction (ctx.userId or tx.setUser after the password or SSO check).
DROP POLICY IF EXISTS member_self_read ON memberships;
CREATE POLICY member_self_read ON memberships FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
