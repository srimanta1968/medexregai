@feature_id:e153ccad-4097-40de-ae9d-38e5b8f1a098 @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.4 Evaluation harness
  Every model is scored on the same fictional gold sets (classification, contradictions,
  drafting, prompt injection; version detection once E2 builds it) through the product's
  own prompts and checks. Owners see how models are judged and our own model's latest
  scores; a firm's own model can be evaluated once it passes its connection test, and only
  a passing model may draft. In an environment where our model has not been evaluated the
  page says so. Source: client/src/pages/app/AiSettingsPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "AI models and cost"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:ed44f813-2413-4096-b867-48164cc9154d
  Scenario: Owner sees how models are evaluated before any model may draft
    Then I should see "How models are evaluated"
    And I should see "A model must reach every target before it may draft."
    And I should see "Our model has not been evaluated in this environment yet."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:9c126f57-ef2e-497c-a6c2-b884f2d0a78d
  Scenario: A firm's own model is not evaluated until it passes its connection test
    When I fill "providerName" with "${random_name}"
    And I fill "providerUrl" with "https://example.com/v1"
    And I fill "providerModel" with "firm-model-1"
    And I fill "providerKey" with "sk-test-0000000000"
    And I click "Add provider"
    Then I should see "Not evaluated yet: drafting stays on our models until it passes"
    And I should see "Run evaluation"
