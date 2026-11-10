@feature_id:becac156-9aac-43e9-bfad-d124358b0bfc @epic_id:5f48b2cc-2827-4919-a54f-d5d55400a2bb
Feature: F0.3 Audit log and activity
  Every view and decision is recorded in a tamper-evident log, and a user can
  see the recent activity of a submission.
  Source: client/src/components/app/ActivityPanel.tsx, server/src/middleware/audit.ts

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:db05b7a1-2320-4c3c-9284-5108779f4af4
  Scenario: User sees recent activity for a submission
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
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
    Then I should see "Recent activity"
    And I should see "created this submission"
    And I should see "Every view, decision and export is recorded in a tamper-evident log."
