@feature_id:313ef090-146c-4c31-8ae2-c2526640c0e0 @epic_id:f514455d-a411-4454-80bd-7993a8652afd
Feature: F5.4 eSTAR XML data file
  On the readiness screen a consultant sees which eSTAR fields MedexRegAI will fill and from where,
  what they must fill by hand, and downloads the XML for Import Data in Adobe Acrobat Pro
  (ADR-019). Shown only when ESTAR_XML_EXPORT=true; dev turns it on. The XML's content (every
  template path kept, codes, one Device per model, one predicate per SE comparison) is proved by
  tests/setup_scripts/52_estar_xml.py and tests/api_definitions/estar-xml/estar-xml-get.json.
  Whether Acrobat Pro imports it cleanly is the manual check in docs/spikes/estar-xml/README.md.
  Source: client/src/components/app/EstarXmlSection.tsx

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:2a49958d-4545-458e-b892-b49e8b771061
  Scenario: Preview and download the eSTAR XML from the readiness screen
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Lindqvist"
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
    And I click "Readiness and records"
    Then I should see "eSTAR data file (XML)"
    And I should see "Not yet proven in Acrobat Pro"
    And I should see "mapping nIVD-7.1/1"
    And I should see "No SE comparison in this project yet"
    And I should see "these in the eSTAR"
    And I should see "regulation and product-code lists by script"
    And I should see "FDA: attachments are never included in an eSTAR XML file."
    When I click "What will be filled"
    Then I should see "New Application/Submission"
    And I should see "Northbay Devices"
    When I click "Download eSTAR XML"
    Then I should see "eSTAR XML downloaded."
