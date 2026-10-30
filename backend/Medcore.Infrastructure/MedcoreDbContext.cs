using Microsoft.EntityFrameworkCore;

namespace Medcore.Infrastructure;

public sealed class MedcoreDbContext(DbContextOptions<MedcoreDbContext> options) : DbContext(options)
{
    public DbSet<UserEntity> Users => Set<UserEntity>();
    public DbSet<PatientEntity> Patients => Set<PatientEntity>();
    public DbSet<OrganizationEntity> Organizations => Set<OrganizationEntity>();
    public DbSet<EmployeeEntity> Employees => Set<EmployeeEntity>();
    public DbSet<MedicalCaseEntity> MedicalCases => Set<MedicalCaseEntity>();
    public DbSet<AttachmentEntity> Attachments => Set<AttachmentEntity>();
    public DbSet<AppointmentEntity> Appointments => Set<AppointmentEntity>();
    public DbSet<TreatmentSummaryEntity> TreatmentSummaries => Set<TreatmentSummaryEntity>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.HasDefaultSchema("project");
        model.Entity<UserEntity>().ToTable("users");
        model.Entity<PatientEntity>().ToTable("patients");
        model.Entity<OrganizationEntity>().ToTable("medical_organizations");
        model.Entity<EmployeeEntity>().ToTable("employees");
        model.Entity<MedicalCaseEntity>().ToTable("medical_cases");
        model.Entity<AttachmentEntity>().ToTable("patient_attachments");
        model.Entity<AppointmentEntity>().ToTable("appointments");
        model.Entity<TreatmentSummaryEntity>().HasKey(x => x.PatientId);
        model.Entity<TreatmentSummaryEntity>().ToView("vw_patient_treatment_summary");
        foreach (var entity in model.Model.GetEntityTypes())
            foreach (var property in entity.GetProperties())
                property.SetColumnName(string.Concat(property.Name.Select((c, i) =>
                    char.IsUpper(c) && i > 0 ? "_" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString())));
    }
}

public sealed class UserEntity
{
    public long Id { get; set; }
    public long? EmployeeId { get; set; }
    public string Login { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public bool IsActive { get; set; }
}

public sealed class PatientEntity
{
    public long Id { get; set; }
    public string LastName { get; set; } = "";
    public string FirstName { get; set; } = "";
    public string? MiddleName { get; set; }
    public DateOnly BirthDate { get; set; }
    public string Sex { get; set; } = "";
    public string? Phone { get; set; }
    public string? Email { get; set; }
    public string? Address { get; set; }
    public bool IsActive { get; set; }
    public int Version { get; set; }
}

public sealed class OrganizationEntity
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string OrganizationType { get; set; } = "";
    public string Address { get; set; } = "";
    public string? Phone { get; set; }
    public bool IsActive { get; set; }
}

public sealed class EmployeeEntity
{
    public long Id { get; set; }
    public string LastName { get; set; } = "";
    public string FirstName { get; set; } = "";
    public string? MiddleName { get; set; }
    public bool IsActive { get; set; }
}

public sealed class MedicalCaseEntity
{
    public long Id { get; set; }
    public long PatientId { get; set; }
    public long OrganizationId { get; set; }
    public string CaseType { get; set; } = "";
    public string Status { get; set; } = "";
    public DateTimeOffset OpenedAt { get; set; }
}

public sealed class AttachmentEntity
{
    public long Id { get; set; }
    public long PatientId { get; set; }
    public long PolyclinicId { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
}

public sealed class TreatmentSummaryEntity
{
    public long PatientId { get; set; }
    public DateTimeOffset? LastVisitAt { get; set; }
    public long CaseCount { get; set; }
    public long HospitalizationCount { get; set; }
    public string TreatmentStatus { get; set; } = "";
}

public sealed class AppointmentEntity
{
    public long Id { get; set; }
    public long CaseId { get; set; }
    public string Status { get; set; } = "";
    public DateTimeOffset? CompletedAt { get; set; }
}
