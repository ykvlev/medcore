using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// DTO маршрутов организаций и структуры. Контракт: docs/project/api-contract.md.

public sealed record OrganizationRow(long Id, string Name, string OrganizationType, string Address,
    string? Phone, bool IsActive, long? ParentHospitalId, string? ParentHospitalName);

public sealed record BedRow(long Id, string Number, bool IsActive, bool Occupied);

public sealed record WardRow(long Id, string Number, int PlannedCapacity, IReadOnlyList<BedRow> Beds);

public sealed record DepartmentRow(long Id, string Name, string? Specialization, long TotalBeds,
    long OccupiedBeds, IReadOnlyList<WardRow> Wards);

public sealed record BuildingRow(long Id, string Number, IReadOnlyList<DepartmentRow> Departments);

public sealed record OrganizationCard(OrganizationRow Organization, IReadOnlyList<BuildingRow> Buildings);

public sealed record CreateOrganizationRequest(
    [property: Required, StringLength(200, MinimumLength = 1)] string Name,
    [property: Required, RegularExpression("^(hospital|polyclinic)$",
        ErrorMessage = "Тип учреждения: hospital или polyclinic")] string OrganizationType,
    [property: Required, StringLength(500, MinimumLength = 1)] string Address,
    [property: StringLength(50)] string? Phone,
    [property: Range(1, long.MaxValue)] long? ParentHospitalId);

public sealed record UpdateOrganizationRequest(
    [property: Required, StringLength(200, MinimumLength = 1)] string Name,
    [property: Required, StringLength(500, MinimumLength = 1)] string Address,
    [property: StringLength(50)] string? Phone,
    bool IsActive);

public sealed record CreateBuildingRequest(
    [property: Required, StringLength(20, MinimumLength = 1)] string Number);

public sealed record CreateDepartmentRequest(
    [property: Required, StringLength(200, MinimumLength = 1)] string Name,
    [property: Range(1, long.MaxValue)] long SpecializationId);

public sealed record CreateWardRequest(
    [property: Required, StringLength(20, MinimumLength = 1)] string Number,
    [property: Range(1, 100)] int PlannedCapacity);

public sealed record CreateBedRequest(
    [property: Required, StringLength(20, MinimumLength = 1)] string Number);

public sealed record UpdateBedRequest([property: Required] bool? IsActive);

public sealed record CreatedId(long Id);

public sealed record DictionaryItem(long Id, string Name);

public sealed record DiagnosisDictionaryItem(string Code, string Name);

public sealed record LabTestTypeDictionaryItem(long Id, string Name, long ProfileId);

public sealed record DictionariesResult(
    IReadOnlyList<DictionaryItem> Specializations,
    IReadOnlyList<DictionaryItem> Specialties,
    IReadOnlyList<DictionaryItem> Categories,
    IReadOnlyList<DictionaryItem> Degrees,
    IReadOnlyList<DictionaryItem> Titles,
    IReadOnlyList<DiagnosisDictionaryItem> Diagnoses,
    IReadOnlyList<LabTestTypeDictionaryItem> LabTestTypes,
    IReadOnlyList<DictionaryItem> Laboratories);
