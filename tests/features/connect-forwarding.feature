@feature_id:717d5baf-5788-4106-9669-e387af1830b0 @epic_id:9d350589-13a9-4573-8e7a-600d3ec59a32
Feature: F2.1 Connect client files: forwarding address and read-only scope
  The Connect screen offers three ways in: a linked folder from Dropbox, Box, SharePoint/OneDrive
  or Google Drive (read-only, its scope explained in plain words per provider before connecting;
  a provider is offered once its OAuth app is set up on the server), a client upload link, and the
  project's own forwarding address. Attachments mailed to the address from the firm's
  members or allowed senders are added to the project's files.
  Source: client/src/pages/app/ProjectConnectPage.tsx

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
    And I click "Connect"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:742d4981-8857-495a-afbf-2d13a0317d98
  Scenario: A consultant reads the read-only scope before linking a folder
    Then I should see "What MedexRegAI can do with a linked folder"
    And I should see "Change, move, rename, delete or share any file."
    And I should see "MedexRegAI can see the names of your Dropbox files and folders and open the files to read them. It cannot edit, move, share or delete anything."
    And I should see "MedexRegAI can read the Box files and folders you can see. It cannot upload, edit, share or delete anything."
    And I should see "MedexRegAI can read files in SharePoint and OneDrive that you can open, and see your name and email. It cannot edit, upload, share or delete anything."
    And I should see "MedexRegAI can see and download your Google Drive files. It cannot edit, upload, share or delete anything."

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:18f7112d-c007-4c3c-a5be-746694a9d897
  Scenario: A consultant turns on the project forwarding address and allows the client's domain
    When I click "Turn on forwarding address"
    Then I should see "Forwarding address is on."
    And I should see "dc-100-traditional-510-k."
    When I fill "allowedSenders" with "client at northbay"
    And I click "Save allowed senders"
    Then I should see "Not an email address or @domain"
    When I fill "allowedSenders" with "@northbay.example, qa@lab.example"
    And I click "Save allowed senders"
    Then I should see "Allowed senders saved."
    When I click "Issue a new address"
    Then I should see "New address issued. The old address no longer works."
    When I click "Turn off"
    Then I should see "Forwarding address turned off."
    And I should see "Turn on forwarding address"
