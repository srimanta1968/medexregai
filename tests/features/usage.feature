@feature_id:a710c1ee-ca46-4272-a45c-7af68c969ba1 @epic_id:7fa09393-08c8-499d-801e-d4aad6a80ab9
Feature: F4.3 Usage
  The firm owner sees, per client and project, the files MedexRegAI read (with their pages,
  sheets or slides) and the section drafts it generated over a date range, and exports usage
  per client, or for all clients, as CSV for rebilling.
  Counts for a parsed client file and the CSV contents are proved by tests/api_definitions/usage/*
  with fixture 44_usage.py; the runner cannot open a downloaded file.
  Usage is a phase 3 menu item (UI 2.0 §3), so the scenarios open /app/usage directly.
  Source: client/src/pages/app/UsagePage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Rebill"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "IS-200 infusion set"
    And I click "Add device"
    And I fill "projectName" with "IS-200 Traditional 510(k)"
    And I click "Start submission"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:4c9bf6b1-ed06-4f7b-b634-612be60d142b
  Scenario: The owner sees usage per client and project and exports one client for rebilling
    When I navigate to "/app/usage"
    Then I should see "What MedexRegAI did for each client"
    And I should see "Northbay Devices"
    And I should see "IS-200 Traditional 510(k)"
    And I should see "1 project · 0 files read"
    And I should see "Pages, sheets or slides"
    When I click "Export Northbay Devices (CSV)"
    Then I should see "Usage for Northbay Devices downloaded."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:5017326a-dfcb-4871-8e75-c0704c1bbc3f
  Scenario: The owner exports usage for all clients
    When I navigate to "/app/usage"
    Then I should see "0 drafts generated"
    When I click "Export all clients (CSV)"
    Then I should see "Usage for all clients downloaded."
