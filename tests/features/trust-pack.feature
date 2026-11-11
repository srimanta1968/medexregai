@feature_id:d33c36a0-2260-4eea-b7c6-54a16726f311 @epic_id:9d350589-13a9-4573-8e7a-600d3ec59a32
Feature: F2.5 Trust pack
  The firm's quality and IT owner gets what they need to assess the tool: a validation
  pack and a data-handling pack as PDF, a clause the firm can give its clients, the
  firm's data-use settings (AI training never; product-improvement use off by default)
  and per-project deletion with a deletion certificate.
  Source: client/src/pages/app/TrustPackPage.tsx, client/src/pages/app/ProjectPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:188db54e-c935-4434-80bb-ab187186e07f
  Scenario: A consultant downloads both packs, copies the client clause and sees the data-use settings
    When I click "Trust pack"
    Then I should see "AI training on your data"
    And I should see "Never"
    And I should see "Off (default)"
    When I click "Download validation pack (PDF)"
    Then I should see "Downloaded medexregai-validation-pack.pdf."
    When I click "Download data-handling pack (PDF)"
    Then I should see "Downloaded medexregai-data-handling-pack.pdf."
    And I should see "never used to train any AI model"
    When I click "Copy clause"
    Then I should see "Clause copied. Paste it into your client agreement."
    When I click "Turn product-improvement use on"
    Then I should see "Product-improvement use is on."
    When I click "Turn product-improvement use off"
    Then I should see "Product-improvement use is off."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:ca3a9b86-c409-44c5-90b7-a6d4e3c769ce
  Scenario: An owner deletes a project's data and downloads the deletion certificate
    When I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "DC-100 catheter"
    And I click "Add device"
    And I fill "projectName" with "DC-100 Traditional 510(k)"
    And I click "Start submission"
    And I click "DC-100 Traditional 510(k)"
    And I click "Delete this project's data"
    And I fill "confirmName" with "DC-100"
    And I click "Delete project data permanently"
    Then I should see "Type the project name exactly to confirm the deletion"
    When I fill "confirmName" with "DC-100 Traditional 510(k)"
    And I click "Delete project data permanently"
    Then I should see "DC-100 Traditional 510(k) was deleted."
    And I should see "Download certificate"
    When I click "Download certificate"
    Then I should see "Downloaded deletion-certificate-"
