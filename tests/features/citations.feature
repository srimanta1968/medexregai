@feature_id:d20fdf5c-e441-4c80-8d1a-8c29f10d6edf @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.3 Search with citations
  Consultants search the passages of a submission's files and open the cited source of
  any result: the passage itself, with its page, sheet range, slide or heading, one
  passage of context either side, and a warning when it is not the latest version.
  Files are added with the development upload; docproc must be running to read them.
  Source: client/src/pages/app/ProjectFilesPage.tsx, client/src/components/app/Citations.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "DC-100 catheter"
    And I click "Add device"
    And I fill "projectName" with "DC-100 Traditional 510(k)"
    And I click "Start submission"
    And I click "DC-100 Traditional 510(k)"
    And I click "Files"
    And I upload "tests/fixtures/ingest/bench-report.docx" to "files"
    And I should see "No patient data found"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:1d922029-3fc9-4c1d-93d4-f0166b292b11
  Scenario: A consultant searches the submission and opens the cited source
    When I fill "searchQuery" with "tensile acceptance criterion"
    And I click "Search"
    Then I should see "bench-report.docx · version 1"
    When I click "Open 5 Results"
    Then I should see "Mean peak tensile force was 42.0 N"
    And I should see "cited"
    When I click "Close"
    Then I should see "Search this submission"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:51ca65c2-fc00-4eb3-a332-7a3e7093a5c5
  Scenario: A search with no matching passage says so
    When I fill "searchQuery" with "cytotoxicity hemolysis"
    And I click "Search"
    Then I should see "No passage matches"
