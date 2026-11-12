@feature_id:ce498dad-6bbe-4344-9969-1d64da4484e5 @epic_id:9d350589-13a9-4573-8e7a-600d3ec59a32
Feature: F2.2 Sorted folder and eSTAR map
  Each file the client sends is read and sorted into an eSTAR section (FDA eSTAR 510(k)
  guidance, 2023-10-02, Table 1) with a confidence score. The consultant can move a file
  to another section; the correction is learned for this firm. The coverage panel shows
  the sections with no evidence, and a getting-started checklist guides the first submission.
  The Test MCP runner cannot upload files, so these scenarios cover what a new submission
  shows; sorting, moving a file and its learning are covered by tests/api_definitions/sorting/.
  Source: client/src/components/app/SortedFolder.tsx (on the project Files page)

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

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:fcae69b4-11db-4767-841c-d24c1744d406
  Scenario: A new submission shows the getting-started checklist
    Then I should see "Getting started"
    And I should see "Connect a folder or add files"
    And I should see "Files sorted into eSTAR sections"
    And I should see "Confirm unclear versions"
    And I should see "Check sections with no evidence"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:598a9758-2569-49a2-abf9-c0786b941e05
  Scenario: The eSTAR coverage panel shows the sections with no evidence
    Then I should see "eSTAR coverage"
    And I should see "Performance Testing"
    And I should see "Biocompatibility"
    And I should see "No evidence yet"
    And I should see "Sections from FDA's eSTAR 510(k) guidance (October 2, 2023), Table 1."
