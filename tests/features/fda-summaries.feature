@feature_id:92e036a2-291f-4be7-a4dc-20cb99879a8f @epic_id:ea4c2ada-2ac3-46a8-8a33-49d7ef9620a1
Feature: F1.2 510(k) summary documents
  The FDA lookup shows whether MedexRegAI holds the public 510(k) summary for a
  K-number: a link to the summary PDF the FDA data service fetched, or "No summary
  on file". Values are real FDA records: K092075 (product code DQY, filed with a
  510(k) statement, so no summary exists) and K262392 (DQY, summary published at
  accessdata.fda.gov/cdrh_docs/pdf26/K262392.pdf and fetched by fda-worker).
  The K262392 scenario needs the FDA data service to have fetched that summary
  (DQY tracked); K092075 holds in any environment with the 510(k) data loaded.
  Source: client/src/pages/app/FdaLookupPage.tsx (SummaryStatus)

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I navigate to "/app/fda-lookup"
    Then I should see "K-number or product code"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:66ff6a0a-3e82-4318-948c-693f73b92516
  Scenario: A K-number filed with a 510(k) statement shows no summary on file
    When I fill "fdaQuery" with "K092075"
    And I click "Look up"
    Then I should see "K092075 verified"
    And I should see "No summary on file"
    And I should see "The FDA lists a 510(k) statement, not a summary, for this clearance"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:6d0f78ad-89e6-462c-a14b-8de69076a63c
  Scenario: A K-number whose summary was fetched links to the summary PDF
    When I fill "fdaQuery" with "K262392"
    And I click "Look up"
    Then I should see "K262392 verified"
    And I should see "Summary PDF on file"
    And I should see "Open the 510(k) summary PDF"
