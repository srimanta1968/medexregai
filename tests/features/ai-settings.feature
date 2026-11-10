@feature_id:4c39a3ec-c61a-4e2b-8b39-2fd1c101a93a @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.1 AI models and cost
  Owners and admins see which model answers each AI step (our self-hosted models by
  default) and their health, can connect their firm's own model with its own API key
  (stored encrypted, shown only as its last four characters, usable only after a
  connection test) and follow AI cost per project.
  Source: client/src/pages/app/AiSettingsPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "AI models and cost"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:9f91f9da-4cfb-4cb3-99c3-842a993cb4d2
  Scenario: Owner sees which model answers each step and the model health
    Then I should see "Which model answers each step"
    And I should see "Drafting"
    And I should see "Our self-hosted model"
    And I should see "Our self-hosted models"
    And I should see "AI cost by project"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:fbaaeacd-ca27-461b-a779-059000d58fc4
  Scenario: Owner adds the firm's own provider and the key is never shown
    When I fill "providerName" with "${random_name}"
    And I fill "providerUrl" with "http://example.com/v1"
    And I fill "providerModel" with "firm-model"
    And I fill "providerKey" with "sk-test-not-a-real-key-0000"
    And I click "Add provider"
    Then I should see "Only https:// URLs are allowed."
    When I fill "providerUrl" with "https://example.com/v1"
    And I click "Add provider"
    Then I should see "Run a connection test before using it."
    And I should see "key ends in 0000"
    And I should see "Not tested yet"
    When I click "Test connection"
    Then I should see "Connection failed"
