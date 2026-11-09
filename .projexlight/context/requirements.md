# Requirements - Quick Prototype Sprint

## Project: MedexRegAI

MedexRegAI helps 510(k) consultants turn the files clients send (test reports, protocols, raw data, specifications and drawings in Word, Excel, PowerPoint and PDF) into eSTAR-ready submission sections. It connects read-only to the folders firms already use (Dropbox, Box, SharePoint/OneDrive, Google Drive), sorts each file into an eSTAR section, and flags gaps and contradictions. It then drafts sections in Word, where every statement cites a source page and the consultant reviews and approves it. It does not replace the firm's eQMS or other systems. The consultant files and signs; MedexRegAI never does.

## Sprint Overview

Quick prototype sprint for generated project structure

## Epics

### User Authentication & Document Processing

This epic encompasses the user authentication process, file uploads, sorting, and drafting functionalities essential for 510(k) consultants to streamline their submission process.

## Features

### User Registration and Authentication

Implement user registration and login functionality to manage user accounts securely.

**Acceptance Criteria:**
["Users can register with email and password.","Users can log in and log out securely.","Password recovery feature is functional."]

### File Upload Functionality

Allow users to upload files from their cloud storage accounts for processing.

**Acceptance Criteria:**
["Users can upload files from supported cloud storage services.","Uploaded files are logged in the system.","Users receive confirmation after successful uploads."]

### File Sorting and Processing

Automatically sort uploaded files into appropriate eSTAR sections based on content analysis.

**Acceptance Criteria:**
["Files are categorized correctly into eSTAR sections.","Consultants can view sorted files in the UI.","Sorting results are logged for review."]

### Draft Generation and Review

Generate drafts in Word format including citations for source pages, and allow users to review drafts before finalization.

**Acceptance Criteria:**
["Drafts are generated correctly based on sorted files.","Users can download and review drafts in Word format.","Citations are included and formatted correctly."]

## Tasks

### Test Sorting Functionality

Conduct thorough testing of the sorting feature.

**Acceptance Criteria:**

### Conduct User Acceptance Testing on Drafts

Test draft generation and review process with users.

**Acceptance Criteria:**

### Create User Registration API

Develop the API endpoint for user registration.

**Acceptance Criteria:**

### Implement User Login API

Develop the API endpoint for user login.

**Acceptance Criteria:**

### Setup Password Recovery Flow

Implement a flow for users to recover their forgotten passwords.

**Acceptance Criteria:**

### Implement Security Measures

Ensure user data is protected during registration and login.

**Acceptance Criteria:**

### Create File Upload API

Develop the API endpoint to handle file uploads.

**Acceptance Criteria:**

### Integrate Cloud Storage APIs

Connect to cloud storage services for file access.

**Acceptance Criteria:**

### Implement File Validation

Ensure uploaded files meet specific criteria before processing.

**Acceptance Criteria:**

### Add User Notifications for Uploads

Notify users upon successful file uploads.

**Acceptance Criteria:**

### Develop Sorting Algorithm

Implement the algorithm to analyze and sort files into sections.

**Acceptance Criteria:**

### Create Sorting API Endpoint

Develop an API for triggering the sorting process.

**Acceptance Criteria:**

### Implement UI for Viewing Sorted Files

Create a user interface for consultants to view sorted files.

**Acceptance Criteria:**

### Implement Draft Generation Logic

Develop the logic to create drafts from sorted files.

**Acceptance Criteria:**

### Create Draft Review Interface

Build a user-friendly interface for reviewing drafts.

**Acceptance Criteria:**

### Enable Draft Download Functionality

Allow users to download drafts in Word format.

**Acceptance Criteria:**

