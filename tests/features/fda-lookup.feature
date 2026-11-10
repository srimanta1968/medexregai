@feature_id:f0f9f188-a539-4d36-a0e9-d3f9d7628df4 @epic_id:ea4c2ada-2ac3-46a8-8a33-49d7ef9620a1
Feature: F1.3 FDA lookup
  A consultant verifies a K-number, looks up a product code and sees recall and
  MAUDE flags from MedexRegAI's copy of public FDA data. A recall-linked device
  is never shown as clean (UI 2.0 §7.2). Values are real FDA records: K251636
  (infusion pump, product code FRN, named in recall Z-1368-2026), K031698
  (no recall), FRN (class 2, 21 CFR 880.5725).
  Source: client/src/pages/app/FdaLookupPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "FDA lookup"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:a15c539e-7eb1-40cb-9e69-a2313959d38f
  Scenario: Consultant verifies a recall-linked K-number
    When I fill "fdaQuery" with "K251636"
    And I click "Look up"
    Then I should see "K251636 verified"
    And I should see "Found in the FDA 510(k) database"
    And I should see "Recall linked"
    And I should see "Z-1368-2026"
    And I should see "Adverse-event reports (MAUDE) for product code FRN"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:f34525f1-5200-4cf2-83d2-518b692765d0
  Scenario: Consultant verifies a K-number with no recall
    When I fill "fdaQuery" with "K031698"
    And I click "Look up"
    Then I should see "K031698 verified"
    And I should see "No FDA recall names K031698"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:75944cd1-4200-4b9f-b231-05cf86d644fe
  Scenario: Consultant looks up a product code
    When I fill "fdaQuery" with "FRN"
    And I click "Look up"
    Then I should see "Product code FRN"
    And I should see "21 CFR 880.5725"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:20b3b7cc-b9d3-4cb6-bb29-83c6bc73e549
  Scenario: Malformed and unknown numbers are explained
    When I fill "fdaQuery" with "12345"
    And I click "Look up"
    Then I should see "Enter a K-number such as K031698"
    When I fill "fdaQuery" with "K000000"
    And I click "Look up"
    Then I should see "K000000 was not found in our copy of the FDA data"
