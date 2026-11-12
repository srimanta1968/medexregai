@feature_id:4bb0c6e6-956d-41c0-a6ee-01496b331169 @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.2 Section draft
  A section is drafted from the client files filed under it; every statement cites its
  source and anything that cannot be tied to a source is removed and listed. With no
  evidence filed, nothing is drafted and the consultant is told why.
  The runner has no file-upload step, so the cited draft itself, the Word export and the
  re-import are proved by tests/api_definitions/drafts/*.json.
  Source: client/src/pages/app/SectionDraftPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Drafter"
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
    And I click "Sterility"
    And I click "Open draft"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:8ec06f99-7814-42a1-b543-5e5c5e4fed0b
  Scenario: A section without a draft offers to draft it
    Then I should see "No draft yet"
    And I should see "Draft this section"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:a801c26c-e916-45b9-a551-99b9fd749a61
  Scenario: Drafting a section with no evidence filed drafts nothing and says why
    When I click "Draft this section"
    Then I should see "Drafting version 1"
    And I should see "No client passages were found for this section"
    And I should see "Removed: no source found · 0"
