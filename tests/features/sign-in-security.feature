@feature_id:0f388230-24e7-4721-bf25-346b65312095 @epic_id:7fa09393-08c8-499d-801e-d4aad6a80ab9
Feature: F4.4 Sign-in security
  Hardening before the external penetration test (docs/compliance/pentest-scope.md section 7):
  a user turns on two-step sign-in with an authenticator app from the Sign-in security page.
  Confirming setup, the second sign-in step, recovery codes and turning it off need live
  TOTP codes, which the runner cannot compute; they are proved by tests/api_definitions/auth/mfa-*
  with fixture 45_auth_security.py. Sign-in throttling is proved by login-post.json (429 case).
  Source: client/src/pages/app/AccountSecurityPage.tsx, client/src/pages/auth/LoginPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Secure"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:8844a8c4-bc8a-469b-a343-00d9498143be
  Scenario: A user starts two-step sign-in setup and a wrong code is refused
    When I click "Ana Secure"
    Then I should see "Sign-in security"
    And I should see "Two-step sign-in is off"
    When I click "Set up two-step sign-in"
    Then I should see "enter this key"
    And I should see "Open in authenticator app"
    When I fill "mfaCode" with "000000"
    And I click "Turn on"
    Then I should see "The code is not correct or has already been used"
    And I should see "Two-step sign-in is off"
