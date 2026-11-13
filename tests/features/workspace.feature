@feature_id:aace117c-ee0f-45ab-8e35-83da03f3824f @epic_id:5f48b2cc-2827-4919-a54f-d5d55400a2bb
Feature: F0.2 Clients, devices and submissions
  A consultant switches between clients and creates client, device and
  submission records; a device keeps a stable identity with an optional UDI-DI.
  Source: client/src/pages/app/ClientsPage.tsx, client/src/pages/app/ProjectPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:adad6379-6469-4e01-9add-7cbb77e9b22d
  Scenario: Consultant creates a client, a device and a submission
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    Then I should see "Clients and projects"
    When I click "Clients and projects"
    Then I should see "Add your first client to start a submission."
    When I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    Then I should see "No devices for Northbay Devices yet."
    When I fill "deviceName" with "IS-200 infusion set"
    And I fill "modelNames" with "IS-200, IS-210"
    And I select "Class II" from "deviceClass"
    And I click "Add device"
    Then I should see "No UDI-DI yet"
    When I fill "projectName" with "IS-200 Special 510(k)"
    And I select "Special 510(k)" from "submissionType"
    And I click "Start submission"
    And I click "IS-200 Special 510(k)"
    Then I should see "Northbay Devices"
    And I should see "IS-200 infusion set (IS-200, IS-210)"
    And I should see "Not recorded yet"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:c9558a83-3063-449c-b798-46c1fd17d597
  Scenario: Consultant switches between clients
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "clientName" with "Harbor Surgical"
    And I click "Add client"
    Then I should see "No devices for Harbor Surgical yet."
    When I select "Northbay Devices" from "clientSwitcher"
    Then I should see "No devices for Northbay Devices yet."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:2c3ea81f-b68f-4d12-88a8-62c517a5e550
  Scenario: Navigation shows the phase 1 project screens
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
    Then I should see "Traditional 510(k)"
    When I click "Problems"
    Then I should see "Check again"
    And I should see "Every finding shows its sources"
