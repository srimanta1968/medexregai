@feature_id:34cf8e34-0e14-4774-9861-0a3050a15c73 @epic_id:f514455d-a411-4454-80bd-7993a8652afd
Feature: F5.2 Predicates and SE comparison
  A consultant searches FDA 510(k) data for candidate predicates by keyword, meaning or the
  subject device's product code, sees each candidate's similarity and recall flags (a
  recall-linked predicate is never shown as clean), builds a cited substantial-equivalence
  comparison, sets a row's comparison and exports it to Word.
  Uses the real FDA data in the fda-data service: the keyword "infusion pump" returns the
  SIGMA Spectrum pumps K251640 and K230022, which have linked recalls. Similarity, flag rules
  and the export contents are proved by tests/api_definitions/predicates/* and
  se-comparisons/* with fixture 49_predicates.py.
  Predicates is a phase 4 menu item; dev turns it on early with FEATURE_FLAGS_ON=predicates.
  Source: client/src/pages/app/ProjectPredicatesPage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:f8870238-5f16-4270-b45d-1435bb6bf108
  Scenario: Search predicates, build a cited SE comparison and export it
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Predicate"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Clients and projects"
    And I fill "clientName" with "Northbay Devices"
    And I click "Add client"
    And I fill "deviceName" with "IS-200 infusion set"
    And I fill "productCode" with "FPA"
    And I click "Add device"
    And I fill "projectName" with "IS-200 Traditional 510(k)"
    And I click "Start submission"
    And I click "IS-200 Traditional 510(k)"
    And I click "Predicates and research"
    Then I should see "a predicate with a linked recall is never shown as clean"
    When I fill "predicateQuery" with "infusion pump"
    And I click "Search by keyword"
    Then I should see "Candidate predicates"
    And I should see "Recall linked"
    And I should see "K230022"
    When I click "Compare with K230022"
    Then I should see "Comparison with K230022 built: 10 rows"
    And I should see "SE comparison with K230022"
    And I should see "Indications for use"
    And I should see "FDA 510(k) database, K230022"
    When I click "Different: Indications for use"
    Then I should see "Indications for use marked different."
    When I click "Export to Word"
    Then I should see "Word file downloaded."
