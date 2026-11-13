@feature_id:d20fdf5c-e441-4c80-8d1a-8c29f10d6edf @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.3 Search with citations
  Consultants search the passages of a submission's files and open the cited source of
  any result: the passage itself, with its page, sheet range, slide or heading, one
  passage of context either side, and a warning when it is not the latest version.
  The runner cannot attach files, so the scenarios sign in to the seeded UI account
  (tests/ui_seed/seed_ui_account.py; run it first) whose Seeded bench evidence project
  already holds the read bench report. Ranking, locations and the citation gate are proved by
  tests/api_definitions/search/* and citations/* with fixture 48_retrieval.py.
  Source: client/src/pages/app/ProjectFilesPage.tsx, client/src/components/app/Citations.tsx

  @scenario_type:UI @ui_test @portal:web @login:owner
  @scenario_id:1d922029-3fc9-4c1d-93d4-f0166b292b11
  Scenario: A consultant searches the submission and opens the cited source
    Given I navigate to "/login"
    When I fill "email" with "${credentials:owner:email}"
    And I fill "password" with "${credentials:owner:password}"
    And I click "Sign in"
    Then I should see "UI Seed Consultant"
    When I navigate to "/app/clients"
    Then I should see "Northbay Devices"
    And I should see "Seeded bench evidence"
    When I click "Seeded bench evidence"
    Then I should see "Client requests"
    When I click "Files"
    Then I should see "Search this submission"
    When I fill "searchQuery" with "tensile acceptance criterion"
    And I click "Search"
    Then I should see "bench-report.docx · version 1"
    When I click "Open 5 Results"
    Then I should see "Mean peak tensile force was 42.0 N"
    And I should see "cited"
    When I click "Close"
    Then I should see "Search this submission"

  @scenario_type:UI @ui_test @portal:web @login:owner
  @scenario_id:51ca65c2-fc00-4eb3-a332-7a3e7093a5c5
  Scenario: A search with no matching passage says so
    Given I navigate to "/login"
    When I fill "email" with "${credentials:owner:email}"
    And I fill "password" with "${credentials:owner:password}"
    And I click "Sign in"
    Then I should see "UI Seed Consultant"
    When I navigate to "/app/clients"
    Then I should see "Northbay Devices"
    And I should see "Seeded bench evidence"
    When I click "Seeded bench evidence"
    Then I should see "Client requests"
    When I click "Files"
    Then I should see "Search this submission"
    When I fill "searchQuery" with "cytotoxicity hemolysis"
    And I click "Search"
    Then I should see "No passage matches"
