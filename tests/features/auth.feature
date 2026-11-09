@feature_id:ea7bf6cb-a1f4-450f-b884-9b7a5b3b9f58 @epic_id:5f48b2cc-2827-4919-a54f-d5d55400a2bb
Feature: F0.1 Accounts, firms and invitations
  A consultant creates a firm workspace, invites a reviewer with a role,
  signs in and out, and can request a password reset.
  Source: client/src/pages/auth/*.tsx, client/src/pages/app/WorkspacePage.tsx, client/src/auth/AuthContext.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:73f37dfd-2746-4e2b-a17a-74a2d5e8649e
  Scenario: Consultant signs up and creates a firm workspace
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    Then I should see "Signed in as"
    And I should see "Users and roles"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:712ea966-2a91-4477-ba94-b7f828999c7b
  Scenario: Firm owner invites a reviewer by email with a role
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    Then I should see "Users and roles"
    When I fill "inviteEmail" with "${random_email}"
    And I select "reviewer" from "inviteRole"
    And I click "Send invitation"
    Then I should see "Invitation sent to"
    And I should see "Pending invitations"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:d862f8d6-4aa7-43f0-9748-4a78a1d1d34c
  Scenario: Registered user signs in and signs out
    Given I navigate to "/login"
    When I fill "email" with "${login:email}"
    And I fill "password" with "${login:password}"
    And I click "Sign in"
    Then I should see "Signed in as"
    When I click "Sign out"
    Then I should see "Welcome back to your firm workspace."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:23128e22-7c6b-4ee7-9346-e7fac0b042c2
  Scenario: User requests a password reset link
    Given I navigate to "/login"
    When I click "Forgot your password?"
    Then I should see "Enter your work email and we will send you a reset link."
    When I fill "email" with "${random_email}"
    And I click "Send reset link"
    Then I should see "a reset link is on its way"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:eee48cd2-24d7-4912-884d-baf92fedd35e
  Scenario: SSO sign-in without an account explains what to do
    Given I navigate to "/login?sso_error=no_account"
    Then I should see "There is no MedexRegAI account for that email yet."
    And I should see "Welcome back to your firm workspace."
