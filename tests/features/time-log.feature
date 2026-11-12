@feature_id:0fa1e67b-32d9-469e-b954-6ab5f0dd6ecd @epic_id:7fa09393-08c8-499d-801e-d4aad6a80ab9
Feature: F4.1 Time log
  A consultant starts and stops a timer per A3 activity in one click (starting another
  activity stops the one running), sees the week's time by day, activity and project, and
  exports totals by project and activity to CSV.
  The CSV contents and totals for a known week are proved by tests/api_definitions/time/*
  with fixture 42_time_log.py; the runner cannot open a downloaded file.
  Source: client/src/pages/app/TimeLogPage.tsx, client/src/components/app/TimerWidget.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Timer"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:a6bae591-d6b4-49af-b045-5a9d8ea71cd4
  Scenario: One click starts a timer, another activity switches it, and the week shows the time
    When I navigate to "/app/time"
    Then I should see "No timer running"
    And I should see "Building summary tables from test data"
    And I should see "Client review rounds on the drafts"
    When I click "Tabulate"
    Then I should see "Tabulate started."
    And I should see "Running: Tabulate"
    When I click "Write"
    Then I should see "Write started; Tabulate stopped after"
    And I should see "Running: Write"
    When I click "Stop timer"
    Then I should see "Write stopped after"
    And I should see "No timer running"
    And I should see "Entries · 2"
    And I should see "By activity"
    And I should see "Export my time (CSV)"
    And I should see "Export firm time (CSV)"
