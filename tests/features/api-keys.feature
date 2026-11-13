@feature_id:ecedaab8-630c-4976-bf61-48e6ddac19ee @epic_id:b95f536e-15e9-439f-8c38-3c18cb05fc92
Feature: F6.3 Billing and API
  A firm owner sees the plans and credit packs offered (Stripe TEST mode, placeholder prices tagged
  app=medexregai in the Stripe test account), starts a Stripe Checkout, and manages API keys.
  Card entry happens on Stripe's hosted page. The runner cannot read text on that cross-origin page
  (assertions there come back empty), so the scenario ends at the click; that it opens a Stripe TEST
  Checkout is proved by billing-checkout-post.json (URL checkout.stripe.com, session cs_test_). The
  paid-webhook
  paths (credits once, plan set and canceled, bad signatures refused) are proved by
  tests/setup_scripts/55_billing.py and tests/api_definitions/billing/.
  That keys reach only /api/v1 and only their own scopes is proved by
  tests/setup_scripts/54_api_keys.py and tests/api_definitions/api-keys/, public-api/.
  Billing and API is a phase 5 menu item; dev turns it on early with FEATURE_FLAGS_ON=billing.
  Source: client/src/pages/app/BillingApiPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:3236f583-e4a5-4957-9ffc-e6b6121b8fe6
  Scenario: Create a scoped API key, see it once, and revoke it
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Lindqvist"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Billing and API"
    Then I should see "Stripe test mode: no real charges"
    And I should see "Credit balance: 0"
    And I should see "No API keys yet."
    When I fill "keyName" with "Dashboard integration"
    And I click "Read the firm's portfolio"
    And I click "Create key"
    Then I should see "Copy this key now. It will not be shown again."
    And I should see "mrk_"
    And I should see "Dashboard integration"
    And I should see "active"
    When I click "Revoke Dashboard integration"
    Then I should see "revoked. It stops working at once."
    And I should see "revoked"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:4e73e850-92a1-43fe-a28d-28a2545a8a7f
  Scenario: Buying credits opens Stripe Checkout
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Lindqvist"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Billing and API"
    Then I should see "MedexRegAI TEST credits (placeholder, not a real price)"
    And I should see "$1.00 for 10 credits"
    And I should see "MedexRegAI TEST plan (placeholder, not a real price)"
    When I click "Buy 10 credits"
