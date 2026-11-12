@feature_id:989d6eb8-075c-49df-8c36-8974220a2936 @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.1 Review board
  Every eSTAR section of a submission is on the board with its status (not started,
  drafting, in review, approved) and an assigned reviewer. Approving needs a role that
  can review drafts; the firm owner can.
  Source: client/src/pages/app/ProjectReviewPage.tsx

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
    And I click "Review"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:86489165-b4a6-4019-83da-f8e02f9449df
  Scenario: The board lists every section as not started
    Then I should see "Review board"
    And I should see "Not started"
    And I should see "Device Description"
    And I should see "Performance Testing"
    And I should see "Approved · 0"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:197a8b8e-6ace-4f9d-8b4e-df6eb3e8870c
  Scenario: A section moves from drafting to review, gets a reviewer and is approved
    When I click "Device Description"
    And I click "Start drafting"
    Then I should see "Device Description moved to Drafting."
    When I click "Send for review"
    Then I should see "Device Description moved to In review."
    When I select "Ana Reviewer" from "sectionReviewer"
    Then I should see "Ana Reviewer will review Device Description."
    When I click "Approve"
    Then I should see "Device Description moved to Approved."
    And I should see "approved by Ana Reviewer"
    And I should see "Approved · 1"
    And I should see "Reviewer: Ana Reviewer"
