@feature_id:0271c2c1-894a-4270-90ba-63ab274e9b6a @epic_id:5f48b2cc-2827-4919-a54f-d5d55400a2bb
Feature: Public homepage
  A visitor learns what MedexRegAI does and finds the way to sign up or sign in.
  Source: client/src/pages/HomePage.tsx

  Scenario: Visitor sees the product promise and the main calls to action
    Given I navigate to "/"
    Then I should see "Turn client files into eSTAR-ready 510(k) sections"
    And I should see "Get started"
    And I should see "Sign in"
    And I should see "See how it works"

  Scenario: Visitor reads how the workflow runs end to end
    Given I navigate to "/"
    When I click "See how it works"
    Then I should see "How it works"
    And I should see "Read and sort"
    And I should see "You decide and file"

  Scenario: Visitor sees the boundaries that never change
    Given I navigate to "/"
    Then I should see "What never changes"
    And I should see "We never file or sign"
    And I should see "Every fact shows its source"

  Scenario: Unknown pages show a not-found screen with a way home
    Given I navigate to "/this-page-does-not-exist"
    Then I should see "Page not found"
    When I click "Back to home"
    Then I should see "Turn client files into eSTAR-ready 510(k) sections"
