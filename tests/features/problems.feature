@feature_id:7a98c57b-d633-406d-9803-39075fa4aee8 @epic_id:9d350589-13a9-4573-8e7a-600d3ec59a32
Feature: F2.3 Problems: gaps and contradictions
  Contradictions between the client's documents and missing evidence are listed by
  severity; each opens with both sources side by side (file, version, page, the exact
  words) and the consultant decides with a note. The Test MCP runner cannot upload
  files, so these scenarios cover a new submission; detection, the side-by-side detail
  and decisions are covered by tests/api_definitions/problems/.
  Source: client/src/pages/app/ProjectProblemsPage.tsx

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
    And I fill "deviceName" with "IS-200 infusion set"
    And I click "Add device"
    And I fill "projectName" with "IS-200 Traditional 510(k)"
    And I click "Start submission"
    And I click "IS-200 Traditional 510(k)"
    And I click "Problems"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:3da15ff4-c0f9-422c-a56a-3a9f9569db0e
  Scenario: A new submission has no problems and can be checked again
    Then I should see "Every finding shows its sources so it can be checked in seconds."
    And I should see "No open problems. Add files or check again after the client sends more."
    When I click "Check again"
    Then I should see "Checked: 0 contradiction(s) and 0 gap(s) found."
    And I should see "Pick a problem to see its sources side by side."
