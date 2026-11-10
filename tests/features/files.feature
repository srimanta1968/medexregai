@feature_id:25aed8eb-2a0c-411e-947c-1963ebf27356 @epic_id:a2a13814-9ec9-4434-93d1-8a294f718a41
Feature: F7.2 Project files, versions and ingest status
  Consultants see every client file in a submission with how it was read (status,
  pages, sheets or slides, passages located), its version history (a file with the
  same name becomes a new version and earlier versions are kept), and a warning with
  a redaction prompt when a file may contain patient data.
  Files are added with the development upload (DEV_UPLOADS=true) until presigned
  uploads (F8.2) and folder connectors (E2) exist; docproc must be running to read them.
  Source: client/src/pages/app/ProjectFilesPage.tsx

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
  @scenario_id:3f81cbed-9fa6-488e-8bdd-1e13ba978ae6
  Scenario: A new submission has no files yet
    Then I should see "No files yet."
    And I should see "Add files"
    And I should see "A file with the same name becomes a new version"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:68913ee9-afc5-41ca-bb78-b9f6c293b5c8
  Scenario: An added report is read and sending the same file again adds no version
    When I upload "tests/fixtures/ingest/bench-report.docx" to "files"
    Then I should see "Added bench-report.docx."
    And I should see "No patient data found"
    When I upload "tests/fixtures/ingest/bench-report.docx" to "files"
    Then I should see "bench-report.docx unchanged: already the latest version."
    When I click "Versions"
    Then I should see "Version 1"
    And I should see "passages located"
    And I should see "copy kept"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:020f177b-1911-48ed-ac62-a99e148d893f
  Scenario: A file with patient data is flagged and the consultant answers the warning
    When I upload "tests/fixtures/ingest/complaints.csv" to "files"
    Then I should see "1 file may contain patient data"
    When I click "Versions"
    Then I should see "This file may contain patient data"
    And I should see "Patient name at sheet complaints"
    And I should see "Date of birth at sheet complaints"
    When I click "Keep as is"
    Then I should see "Kept after review."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:59e3cd26-cb57-4f61-b01d-505f5ef36b8c
  Scenario: A drawing's title block is read
    When I upload "tests/fixtures/ingest/hub-drawing.pdf" to "files"
    Then I should see "No patient data found"
    When I click "Versions"
    Then I should see "Title block: part DC-100-HUB, drawing D-10042, revision C"
