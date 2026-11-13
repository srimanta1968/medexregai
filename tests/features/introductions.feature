@feature_id:a44bb850-46f5-44bd-920e-205427202979 @epic_id:b95f536e-15e9-439f-8c38-3c18cb05fc92
Feature: F6.2 Opt-in introductions
  A consultant firm opts in to introductions for the FDA specialties and pathways it takes. A
  device company asks to be introduced; the request is offered only to opted-in firms that match.
  The firm sees the description first and the company's contact only after accepting.
  That other firms (not opted in, or another specialty) never receive the request is proved
  across firms by tests/setup_scripts/53_introductions.py and tests/api_definitions/introductions/.
  HQL (intraocular lens) is Ophthalmic, Class III, PMA in FDA's classification data.
  Introductions is a phase 5 menu item; dev turns it on early with FEATURE_FLAGS_ON=introductions.
  Sources: client/src/pages/app/IntroductionsPage.tsx, client/src/pages/IntroductionRequestPage.tsx

  The Test MCP runner cannot tick a checkbox (its steps are navigate, fill, click, select, should-see,
  login), so the consent box blocks a full submit here: this scenario proves the consent guard, and
  accepting a routed request (contact revealed, company emailed) is proved by fixture 53 and
  tests/api_definitions/introductions/introduction-accept-post.json.

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:fba401e6-2bc9-4016-99c0-8d329c9e3154
  Scenario: A firm opts in; a company must consent before its request is sent
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Lindqvist"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"
    And I click "Introductions"
    Then I should see "not receiving introductions"
    When I click "Ophthalmic"
    And I click "PMA"
    And I click "Opt in to introductions"
    Then I should see "Your firm now receives introductions that match."
    And I should see "receiving introductions"
    Given I navigate to "/codes/HQL"
    When I click "Ask to be introduced to a regulatory consultant"
    Then I should see "Find a regulatory consultant"
    When I fill "companyName" with "Optisight Labs (FICTIONAL)"
    And I fill "contactName" with "Sam Okafor"
    And I fill "contactEmail" with "${random_email}"
    And I fill "brief" with "FICTIONAL TEST DATA: a novel foldable intraocular lens; we need help with a PMA."
    And I click "PMA"
    And I click "Ask for an introduction"
    Then I should see "You must agree that your request may be shared with consultant firms"
    Given I navigate to "/app/introductions"
    Then I should see "Introductions offered to your firm"
    And I should see "None yet."
    When I click "Stop receiving introductions"
    Then I should see "Your firm no longer receives new introductions."
    And I should see "not receiving introductions"
