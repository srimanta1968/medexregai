@feature_id:6063e5f0-b02d-40d4-9242-3d41b4326277 @epic_id:b95f536e-15e9-439f-8c38-3c18cb05fc92
Feature: F6.1 Public product-code pages
  A visitor, without signing in, looks up an FDA product code and sees what FDA has cleared under
  it, the typical time from FDA receipt to decision, recall themes and the sources, all from FDA
  data only. From the page they can run a free device check.
  Uses the real FDA data in the fda-data service; FPA is Class II, 21 CFR 880.5440, 510(k).
  The figures themselves are checked by tests/setup_scripts/51_public_codes.py and the
  definitions in tests/api_definitions/public/ (cross-checked against api.fda.gov).
  Source: client/src/pages/ProductCodePage.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:6800fd4e-cc19-40c8-9c23-04b50e7eeb8e
  Scenario: A visitor looks up a product code and runs the free device check
    Given I navigate to "/codes"
    Then I should see "FDA product codes"
    When I fill "productCodeLookup" with "fpa"
    And I click "Look up"
    Then I should see "Product code FPA: Set, Administration, Intravascular"
    And I should see "Class II · 21 CFR 880.5440"
    And I should see "Pathway: 510(k)."
    And I should see "median time from FDA receipt to decision"
    And I should see "this is not FDA's review-day count"
    And I should see "Most recent clearances"
    And I should see "Recall themes"
    And I should see "FDA product classification database, FPA"
    When I fill "deviceDescription" with "FICTIONAL TEST DATA. A single-use sterile intravascular administration set with a spike, drip chamber and roller clamp."
    And I click "Run the free check"
    Then I should see "Your check result"
    And I should see "Likely pathway: 510(k)."
    And I should see "Cleared devices with names closest to your description"
    And I should see "not a finding of substantial equivalence"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:5aa95b74-a717-401b-8a92-5fa15d086a4d
  Scenario: An unknown product code says so and offers another lookup
    Given I navigate to "/codes/ZZZ"
    Then I should see "Product code ZZZ is not in our copy of the FDA classification database"
    And I should see "Look up"
