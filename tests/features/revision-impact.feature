@feature_id:155a7678-363d-4da7-9b55-7e38f099069e @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.3 Revision impact
  When a client sends a new version of a file, the Changes page lists everything that cited
  the old version (draft statements by section, problems, client request items), each with
  an action; nothing changes until the consultant chooses.
  The runner has no file-upload step, so a project here has no revised file: the impact list
  and its actions are proved by tests/api_definitions/impact/*.json (fixture 20_section_draft.py
  uploads a revised report after drafting).
  Source: client/src/pages/app/ProjectChangesPage.tsx

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
    And I click "Changes"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:b69d9373-d356-4a78-9bb9-03b405458fba
  Scenario: A project without revised files says so
    Then I should see "Changes"
    And I should see "No new versions yet"
    And I should see "When a client sends a revised file, it appears here with everything it affects."
