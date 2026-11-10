@feature_id:0ba457df-13a5-4147-befe-1fad40b8324f @epic_id:ea4c2ada-2ac3-46a8-8a33-49d7ef9620a1
Feature: F1.1 openFDA copy and data-as-of date
  MedexRegAI keeps its own copy of public openFDA device data, refreshed on a
  schedule, and every FDA-derived view shows the date of that data.
  Source: client/src/components/app/FdaDataAsOf.tsx, client/src/pages/app/FdaSourcesPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:89ef50e6-52c0-455a-aa3b-9dcbc65392b7
  Scenario: User sees the FDA data-as-of date and its sources
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "FDA data sources"
    Then I should see "FDA data as of"
    And I should see "Device classification"
    And I should see "510(k) clearances"
    And I should see "Source: openFDA (open.fda.gov), U.S. Food and Drug Administration."
