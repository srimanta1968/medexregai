@feature_id:0ad2942c-8e6a-42bb-ad18-257d9cb83890 @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.4 Readiness and records
  The project's filed attachments are checked against FDA's eSTAR rules for the chosen
  template, with the running total against the 4 GB limit, and dated records (project record,
  problem log, client request log) are generated for the firm's eQMS.
  The runner cannot upload files, so flagged attachments (a 125-character name, a zip) are
  proved by tests/api_definitions/readiness/*.json with fixture 30_readiness.py.
  Source: client/src/pages/app/ProjectReadinessPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Reviewer"
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
    And I click "IS-200 Traditional 510(k)"
    And I click "Readiness and records"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:42ac59ff-0326-4134-9800-f3421918639d
  Scenario: Checks follow the chosen eSTAR template and quote FDA's limits
    Then I should see "eSTAR attachment checks"
    And I should see "No files are filed under an eSTAR section yet"
    And I should see "Total 0 bytes of 4.00 GB"
    And I should see "names over 124 characters are not accepted"
    When I select "IVD eSTAR 7.1" from "estarTemplate"
    Then I should see "Checked against IVD eSTAR 7.1."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:b191dd5c-8c5f-4d44-9168-33e42c5ce8d7
  Scenario: A dated project record is generated and logged
    When I click "PDF"
    Then I should see "Project record (PDF) generated and logged."
    And I should see "Generated so far · 1"
    And I should see "SHA-256"
