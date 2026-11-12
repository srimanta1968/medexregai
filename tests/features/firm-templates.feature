@feature_id:80537ab9-7bf2-419f-b19d-0e8f8e76968b @epic_id:5d0b3c77-a0ba-4b5e-b4db-f1b36462d071
Feature: F3.6 Templates and admin docs
  A firm keeps its own section templates and past wording, opt-in and used only for that
  firm; drafting follows them as style while every fact still cites a client file. The
  review board drafts the summary of testing (with its mismatch count) and the 510(k)
  Summary, cover letter, FDA 3601 preparation sheet and Truthful and Accurate statement
  from project data, with every signature field left blank.
  This file covers the template manager; tests/features/firm-docs.feature covers the review
  board documents and the draft screen. A draft written with firm style is proved by
  tests/api_definitions/drafts/section-draft-get.json with fixture 41_firm_style.py.
  Source: client/src/pages/app/FirmTemplatesPage.tsx

  Background:
    Given I navigate to "/signup"
    When I fill "fullName" with "Ana Templates"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${default:password}"
    And I fill "firmName" with "${random_name}"
    And I click "Create workspace"

  @scenario_type:UI @ui_test @portal:web
  @scenario_id:e430bd87-4d17-4f32-b058-b4db79ea8656
  Scenario: A firm turns on style sources and adds a template and past wording
    When I navigate to "/app/templates"
    Then I should see "Off: new drafts use no templates or past wording"
    When I click "Turn on firm style"
    Then I should see "Firm style sources are on: drafts started from now follow your templates and past wording."
    When I fill "templateName" with "Firm device description outline"
    And I fill "templateBody" with "Principle of operation first, then components and materials, then accessories."
    And I click "Add template"
    Then I should see "Template added: Firm device description outline."
    And I should see "Device description: Firm device description outline"
    When I fill "precedentSource" with "K201234, Device description"
    And I fill "precedentText" with "The subject device consists of a drip chamber, tubing and a roller clamp."
    And I click "Add wording"
    Then I should see "Past wording added from K201234, Device description."
    And I should see "Device description · K201234, Device description"
